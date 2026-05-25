#!/usr/bin/env node

import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const DEFAULT_AGENT = "Codex";
const DEFAULT_TITLE_WIDTH = 19;
const PRODUCT_NAME = "Take Your Token Receipt";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`tytr: ${error.message}`);
  process.exit(1);
});

async function main() {
  if (args.help) {
    console.log(helpText());
    return;
  }

  const sessionsDir = args.sessionsDir || process.env.CODEX_SESSIONS_DIR || DEFAULT_CODEX_SESSIONS_DIR;
  const sessions = await readCodexSessions(sessionsDir);

  if (sessions.length === 0) {
    throw new Error(`no Codex session files found in ${sessionsDir}`);
  }

  const selectedSessions = args.all ? sessions : [sessions.at(-1)];
  const report = buildReport(selectedSessions, {
    agent: args.agent || DEFAULT_AGENT,
    inputRate: args.inputRate,
    outputRate: args.outputRate,
  });
  const receipt = renderReceipt(report);

  if (args.save) {
    await writeFile(resolve(args.save), `${receipt}\n`, "utf8");
  }

  if (args.pdf) {
    await writeFile(resolve(args.pdf), renderReceiptPdf(receipt));
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(receipt);
}

function parseArgs(argv) {
  const parsed = {
    all: false,
    help: false,
    json: false,
    pdf: "",
    save: "",
    sessionsDir: "",
    agent: "",
    inputRate: 0,
    outputRate: 0,
    titleWidth: DEFAULT_TITLE_WIDTH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--all") parsed.all = true;
    else if (arg === "--latest") parsed.all = false;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--pdf") parsed.pdf = requireValue(argv, (index += 1), "--pdf");
    else if (arg === "--save") parsed.save = requireValue(argv, (index += 1), "--save");
    else if (arg === "--sessions-dir") parsed.sessionsDir = requireValue(argv, (index += 1), "--sessions-dir");
    else if (arg === "--agent") parsed.agent = requireValue(argv, (index += 1), "--agent");
    else if (arg === "--input-rate") parsed.inputRate = numberValue(argv, (index += 1), "--input-rate");
    else if (arg === "--output-rate") parsed.outputRate = numberValue(argv, (index += 1), "--output-rate");
    else if (arg === "--title-width") parsed.titleWidth = numberValue(argv, (index += 1), "--title-width");
    else if (arg === "codex") continue;
    else throw new Error(`unknown option: ${arg}`);
  }

  return parsed;
}

function requireValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function numberValue(argv, index, option) {
  const value = Number(requireValue(argv, index, option));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${option} must be a non-negative number`);
  }
  return value;
}

async function readCodexSessions(sessionsDir) {
  const files = await collectJsonlFiles(sessionsDir);
  const sessions = [];

  for (const filePath of files) {
    const session = await parseCodexSession(filePath);
    if (session.turns.length > 0) {
      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
}

async function collectJsonlFiles(dir) {
  if (!existsSync(dir)) return [];

  const files = [];
  const items = await readdir(dir, { withFileTypes: true });

  for (const item of items) {
    const itemPath = join(dir, item.name);
    if (item.isDirectory()) {
      files.push(...(await collectJsonlFiles(itemPath)));
    } else if (item.isFile() && item.name.endsWith(".jsonl")) {
      files.push(itemPath);
    }
  }

  return files;
}

async function parseCodexSession(filePath) {
  const fileStat = await stat(filePath);
  const content = await readFile(filePath, "utf8");
  const turns = [];
  let title = "";
  let updatedAt = fileStat.mtime.toISOString();
  let cumulativeUsage = emptyUsage();
  let model = "";
  let limitName = "";

  content.split(/\r?\n/).forEach((line, lineIndex) => {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);
      const payload = event.payload ?? {};

      if (!title && payload.type === "user_message") {
        title = firstLine(payload.message);
      }

      if (event.timestamp) {
        updatedAt = event.timestamp;
      }

      if (typeof payload.model === "string" && payload.model.trim()) {
        model = payload.model.trim();
      }

      if (event.type !== "event_msg" || payload.type !== "token_count") return;

      const lastUsage = usageFrom(payload.info?.last_token_usage);
      const totalUsage = usageFrom(payload.info?.total_token_usage);
      if (totalUsage.totalTokens > 0) {
        cumulativeUsage = totalUsage;
      }
      limitName = payload.rate_limits?.limit_name || limitName;

      turns.push({
        id: `${filePath}:${lineIndex}:${event.timestamp}`,
        timestamp: event.timestamp,
        usage: lastUsage,
      });
    } catch {
      // Codex can be writing the latest JSONL line while we read it.
    }
  });

  return {
    filePath,
    fileName: basename(filePath),
    title: title || titleFromFile(filePath),
    updatedAt,
    model,
    limitName,
    turns,
    cumulativeUsage,
  };
}

function firstLine(text) {
  return String(text ?? "")
    .trim()
    .split(/\r?\n/)
    .find(Boolean)
    ?.slice(0, 80);
}

function titleFromFile(filePath) {
  return basename(filePath).replace(/^rollout-/, "").replace(/\.jsonl$/, "") || "Codex session";
}

function usageFrom(raw) {
  return {
    inputTokens: toInt(raw?.input_tokens),
    cachedInputTokens: toInt(raw?.cached_input_tokens),
    outputTokens: toInt(raw?.output_tokens),
    reasoningOutputTokens: toInt(raw?.reasoning_output_tokens),
    totalTokens: toInt(raw?.total_tokens),
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function toInt(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function buildReport(sessions, options) {
  const totals = sessions.reduce((sum, session) => addUsage(sum, session.cumulativeUsage), emptyUsage());
  const cost = (totals.inputTokens / 1_000_000) * options.inputRate + (totals.outputTokens / 1_000_000) * options.outputRate;

  return {
    agent: options.agent,
    logo: logoFor(options.agent),
    generatedAt: new Date().toISOString(),
    sessions: sessions.map((session) => ({
      title: session.title,
      fileName: session.fileName,
      updatedAt: session.updatedAt,
      model: session.model,
      limitName: session.limitName,
      turns: session.turns.length,
      usage: session.cumulativeUsage,
    })),
    totals,
    pricing: {
      inputRatePerMillion: options.inputRate,
      outputRatePerMillion: options.outputRate,
      estimatedCostUsd: cost,
    },
  };
}

function addUsage(left, right) {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

function logoFor(agent) {
  const normalized = agent.toLowerCase();
  if (normalized.includes("codex") || normalized.includes("openai")) {
    return [
      "   ____          _           ",
      "  / ___|___   __| | _____  __",
      " | |   / _ \\ / _` |/ _ \\ \\/ /",
      " | |__| (_) | (_| |  __/>  < ",
      "  \\____\\___/ \\__,_|\\___/_/\\_\\",
    ];
  }

  return [
    "     _    ___ ",
    "    / \\  |_ _|",
    "   / _ \\  | | ",
    "  / ___ \\ | | ",
    " /_/   \\_\\___|",
  ];
}

function renderReceipt(report) {
  const lines = [];
  const latest = report.sessions.at(-1);

  lines.push("========================================");
  lines.push("       TAKE YOUR TOKEN RECEIPT");
  lines.push("========================================");
  report.logo.forEach((line) => lines.push(line));
  lines.push("----------------------------------------");
  lines.push(`Agent: ${report.agent}`);
  lines.push(`Generated: ${formatDate(report.generatedAt)}`);
  lines.push(`Mode: ${report.sessions.length === 1 ? "latest Codex session" : "all Codex sessions"}`);
  if (latest?.model) lines.push(`Model: ${latest.model}`);
  if (latest?.limitName) lines.push(`Limit bucket: ${latest.limitName}`);
  lines.push("----------------------------------------");
  lines.push(`Sessions: ${formatNumber(report.sessions.length)}`);
  lines.push(`Turns: ${formatNumber(report.sessions.reduce((sum, session) => sum + session.turns, 0))}`);
  lines.push(`Input tokens: ${formatNumber(report.totals.inputTokens)}`);
  lines.push(`Cached input: ${formatNumber(report.totals.cachedInputTokens)}`);
  lines.push(`Output tokens: ${formatNumber(report.totals.outputTokens)}`);
  lines.push(`Reasoning output: ${formatNumber(report.totals.reasoningOutputTokens)}`);
  lines.push(`Total tokens: ${formatNumber(report.totals.totalTokens)}`);

  if (report.pricing.inputRatePerMillion > 0 || report.pricing.outputRatePerMillion > 0) {
    lines.push(`Estimated cost: $${report.pricing.estimatedCostUsd.toFixed(4)}`);
  }

  lines.push("----------------------------------------");
  report.sessions.slice(-8).forEach((session, index) => {
    const titleLines = wrapText(session.title, args.titleWidth);
    const prefix = `${String(index + 1).padStart(2, "0")}. `;
    lines.push(`${prefix}${titleLines[0] ?? "Untitled Codex session"}`);
    titleLines.slice(1).forEach((line) => {
      lines.push(`    ${line}`);
    });
    lines.push(`    ${formatDate(session.updatedAt)} | ${formatNumber(session.usage.totalTokens)} tokens`);
  });
  lines.push("----------------------------------------");
  lines.push("Keep this receipt for review and billing.");
  lines.push("========================================");

  return lines.join("\n");
}

function renderReceiptPdf(receipt) {
  const lines = receipt.split("\n");
  const pageWidth = 226.77; // 80mm thermal receipt width in PDF points.
  const fontSize = 7.6;
  const lineHeight = 9.8;
  const marginX = 16;
  const marginY = 18;
  const pageHeight = Math.max(300, marginY * 2 + lines.length * lineHeight);
  let y = pageHeight - marginY - fontSize;

  const content = [];
  content.push("q");
  content.push("0.985 0.975 0.940 rg");
  content.push(`0 0 ${fixed(pageWidth)} ${fixed(pageHeight)} re f`);
  content.push("Q");
  content.push("0.08 0.07 0.06 rg");

  lines.forEach((line) => {
    const fontName = hasNonAscii(line) ? "FCjk" : "FMono";
    const text = hasNonAscii(line) ? `<${utf16BeHex(line)}>` : `(${escapePdfString(line)})`;
    content.push(`BT /${fontName} ${fontSize} Tf ${fixed(marginX)} ${fixed(y)} Td ${text} Tj ET`);
    y -= lineHeight;
  });

  return buildPdf({
    pageWidth,
    pageHeight,
    content: content.join("\n"),
  });
}

function buildPdf({ pageWidth, pageHeight, content }) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fixed(pageWidth)} ${fixed(pageHeight)}] /Resources << /Font << /FMono 5 0 R /FCjk 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 8 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
  ];

  const chunks = ["%PDF-1.4\n%\xFF\xFF\xFF\xFF\n"];
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join(""), "binary"));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });

  const xrefOffset = Buffer.byteLength(chunks.join(""), "binary");
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  offsets.slice(1).forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`);
  chunks.push(`startxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "binary");
}

function fixed(value) {
  return Number(value).toFixed(2);
}

function hasNonAscii(text) {
  return /[^\x00-\x7F]/.test(text);
}

function escapePdfString(text) {
  return text.replace(/[\\()]/g, "\\$&");
}

function utf16BeHex(text) {
  let hex = "";
  for (let index = 0; index < text.length; index += 1) {
    hex += text.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return hex.toUpperCase();
}

function wrapText(text, width) {
  const maxWidth = Math.max(12, width);
  const normalized = String(text ?? "Untitled Codex session").replace(/\s+/g, " ").trim();
  const chars = Array.from(normalized);
  const lines = [];

  for (let index = 0; index < chars.length && lines.length < 2; index += maxWidth) {
    lines.push(chars.slice(index, index + maxWidth).join("").trim());
  }

  if (chars.length > maxWidth * 2 && lines.length > 0) {
    const last = lines.length - 1;
    lines[last] = `${lines[last].slice(0, Math.max(0, maxWidth - 3)).trim()}...`;
  }

  return lines.length > 0 ? lines : ["Untitled Codex session"];
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "unknown";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function helpText() {
  return `
${PRODUCT_NAME}

Usage:
  tytr [codex] [options]
  token-receipt [codex] [options]
  node bin/tytr.mjs [codex] [options]

Options:
  --latest                  Print the latest Codex session receipt (default)
  --all                     Aggregate all local Codex sessions
  --sessions-dir <path>     Read Codex JSONL sessions from a custom directory
  --agent <name>            Agent name shown on the receipt (default: Codex)
  --input-rate <usd>        Input price per 1M tokens, used only for cost estimate
  --output-rate <usd>       Output price per 1M tokens, used only for cost estimate
  --title-width <chars>     Session title width before wrapping/truncation (default: ${DEFAULT_TITLE_WIDTH})
  --save <path>             Save the receipt as a text file
  --pdf <path>              Save an 80mm receipt-style PDF
  --json                    Output machine-readable JSON instead of a receipt
  -h, --help                Show help

Examples:
  tytr
  tytr --all
  tytr --save receipt.txt
  tytr --pdf receipt.pdf
  tytr --input-rate 5 --output-rate 15
`.trim();
}
