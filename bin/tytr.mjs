#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");
const DEFAULT_CLAUDE_CODE_SESSIONS_DIR = join(homedir(), ".claude", "projects");
const DEFAULT_AGENT = "Codex";
const DEFAULT_TITLE_WIDTH = 19;
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICON_PATHS = {
  codex: resolve(PROJECT_ROOT, "icons", "codex.png"),
  claude: resolve(PROJECT_ROOT, "icons", "claudecode-color.png"),
};
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

  const sessionsDir = args.sessionsDir || defaultSessionsDirFor(args.provider);
  const sessions = await readAgentSessions(args.provider, sessionsDir);

  if (sessions.length === 0) {
    throw new Error(`no ${agentNameFor(args.provider)} session files found in ${sessionsDir}`);
  }

  const selectedSessions = args.all ? sessions : [sessions.at(-1)];
  const report = buildReport(selectedSessions, {
    agent: args.agent || agentNameFor(args.provider),
    provider: args.provider,
    all: args.all,
    inputRate: args.inputRate,
    outputRate: args.outputRate,
  });
  const receipt = renderReceipt(report);

  if (args.save) {
    await writeFile(resolve(args.save), `${receipt}\n`, "utf8");
  }

  if (args.pdf) {
    await writeFile(resolve(args.pdf), await renderReceiptPdf(receipt, { iconPath: iconPathFor(args.provider) }));
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
    provider: "codex",
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
    else if (arg === "--provider") parsed.provider = normalizeProvider(requireValue(argv, (index += 1), "--provider"));
    else if (arg === "--sessions-dir") parsed.sessionsDir = requireValue(argv, (index += 1), "--sessions-dir");
    else if (arg === "--agent") parsed.agent = requireValue(argv, (index += 1), "--agent");
    else if (arg === "--input-rate") parsed.inputRate = numberValue(argv, (index += 1), "--input-rate");
    else if (arg === "--output-rate") parsed.outputRate = numberValue(argv, (index += 1), "--output-rate");
    else if (arg === "--title-width") parsed.titleWidth = numberValue(argv, (index += 1), "--title-width");
    else if (isProviderName(arg)) parsed.provider = normalizeProvider(arg);
    else throw new Error(`unknown option: ${arg}`);
  }

  return parsed;
}

function isProviderName(value) {
  const normalized = value.toLowerCase();
  return ["codex", "openai", "claude", "claudecode", "claude-code"].includes(normalized);
}

function normalizeProvider(value) {
  const normalized = value.toLowerCase();
  if (normalized === "codex" || normalized === "openai") return "codex";
  if (normalized === "claude" || normalized === "claudecode" || normalized === "claude-code") return "claude";
  throw new Error(`unknown provider: ${value}`);
}

function defaultSessionsDirFor(provider) {
  if (provider === "claude") {
    return process.env.CLAUDE_CODE_SESSIONS_DIR || process.env.CLAUDE_CODE_PROJECTS_DIR || DEFAULT_CLAUDE_CODE_SESSIONS_DIR;
  }

  return process.env.CODEX_SESSIONS_DIR || DEFAULT_CODEX_SESSIONS_DIR;
}

function agentNameFor(provider) {
  return provider === "claude" ? "Claude Code" : DEFAULT_AGENT;
}

function iconPathFor(provider) {
  return ICON_PATHS[provider] || ICON_PATHS.codex;
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

async function readAgentSessions(provider, sessionsDir) {
  if (provider === "claude") return readClaudeCodeSessions(sessionsDir);
  return readCodexSessions(sessionsDir);
}

async function readClaudeCodeSessions(sessionsDir) {
  const files = await collectJsonlFiles(sessionsDir);
  const sessions = [];

  for (const filePath of files) {
    const session = await parseClaudeCodeSession(filePath);
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

async function parseClaudeCodeSession(filePath) {
  const fileStat = await stat(filePath);
  const content = await readFile(filePath, "utf8");
  const usageByMessage = new Map();
  let title = "";
  let updatedAt = fileStat.mtime.toISOString();
  let model = "";

  content.split(/\r?\n/).forEach((line, lineIndex) => {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);
      const message = event.message ?? {};

      if (!title && event.type === "user") {
        title = firstLine(textFromClaudeContent(message.content));
      }

      if (typeof event.aiTitle === "string" && event.aiTitle.trim()) {
        title = event.aiTitle.trim();
      }

      if (event.timestamp) {
        updatedAt = event.timestamp;
      }

      if (typeof message.model === "string" && message.model.trim()) {
        model = message.model.trim();
      }

      if (event.type !== "assistant" || !message.usage) return;

      const messageId = message.id || event.uuid || `${filePath}:${lineIndex}`;
      usageByMessage.set(messageId, {
        id: messageId,
        timestamp: event.timestamp || updatedAt,
        usage: claudeUsageFrom(message.usage),
      });
    } catch {
      // Claude Code can be writing the latest JSONL line while we read it.
    }
  });

  const turns = Array.from(usageByMessage.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const cumulativeUsage = turns.reduce((sum, turn) => addUsage(sum, turn.usage), emptyUsage());

  return {
    filePath,
    fileName: basename(filePath),
    title: title || titleFromFile(filePath, "Claude Code session"),
    updatedAt,
    model,
    limitName: "",
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

function titleFromFile(filePath, fallback = "Codex session") {
  return basename(filePath).replace(/^rollout-/, "").replace(/\.jsonl$/, "") || fallback;
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

function claudeUsageFrom(raw) {
  const nestedCacheCreationInputTokens = toInt(raw?.cache_creation?.ephemeral_1h_input_tokens) + toInt(raw?.cache_creation?.ephemeral_5m_input_tokens);
  const topLevelCacheCreationInputTokens = toInt(raw?.cache_creation_input_tokens);
  const cacheCreationInputTokens = topLevelCacheCreationInputTokens || nestedCacheCreationInputTokens;
  const cachedInputTokens = toInt(raw?.cache_read_input_tokens);
  const directInputTokens = toInt(raw?.input_tokens);
  const outputTokens = toInt(raw?.output_tokens);
  const reasoningOutputTokens = toInt(raw?.reasoning_output_tokens ?? raw?.thinking_output_tokens);
  const inputTokens = directInputTokens + cacheCreationInputTokens + cachedInputTokens;

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: inputTokens + outputTokens + reasoningOutputTokens,
  };
}

function textFromClaudeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
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
    provider: options.provider,
    mode: options.all ? "all" : "latest",
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

  if (normalized.includes("claude")) {
    return [
      "   ____ _                 _      ",
      "  / ___| | __ _ _   _  __| | ___ ",
      " | |   | |/ _` | | | |/ _` |/ _ \\",
      " | |___| | (_| | |_| | (_| |  __/",
      "  \\____|_|\\__,_|\\__,_|\\__,_|\\___|",
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

function centerLine(text, width = 40) {
  const value = String(text);
  const left = Math.max(0, Math.floor((width - value.length) / 2));
  return `${" ".repeat(left)}${value}`;
}

function renderReceipt(report) {
  const lines = [];
  const latest = report.sessions.at(-1);

  lines.push("========================================");
  lines.push(centerLine("TAKE YOUR TOKEN RECEIPT"));
  lines.push("========================================");
  report.logo.forEach((line) => lines.push(line));
  lines.push("----------------------------------------");
  lines.push(`Agent: ${report.agent}`);
  lines.push(`Generated: ${formatDate(report.generatedAt)}`);
  lines.push(`Mode: ${report.mode === "all" ? `all ${report.agent} sessions` : `latest ${report.agent} session`}`);
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
    lines.push(`Input rate: $${formatMoney(report.pricing.inputRatePerMillion)}/1M`);
    lines.push(`Output rate: $${formatMoney(report.pricing.outputRatePerMillion)}/1M`);
    lines.push(`Estimated cost: $${report.pricing.estimatedCostUsd.toFixed(4)}`);
  }

  lines.push("----------------------------------------");
  const receiptSessions = report.mode === "all" ? report.sessions : report.sessions.slice(-8);
  receiptSessions.forEach((session, index) => {
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

async function renderReceiptPdf(receipt, options = {}) {
  const lines = receipt.split("\n");
  const pageWidth = 226.77; // 80mm thermal receipt width in PDF points.
  const fontSize = 7.6;
  const lineHeight = 9.8;
  const marginX = 16;
  const marginY = 18;
  const icon = await readPngIcon(options.iconPath);
  const iconSize = icon ? 32 : 0;
  const iconGap = icon ? 4 : 0;
  const pageHeight = Math.max(300, marginY * 2 + iconSize + iconGap + lines.length * lineHeight);
  let y = pageHeight - marginY - fontSize;

  const content = [];
  content.push("q");
  content.push("0.985 0.975 0.940 rg");
  content.push(`0 0 ${fixed(pageWidth)} ${fixed(pageHeight)} re f`);
  content.push("Q");
  content.push("0.08 0.07 0.06 rg");

  if (icon) {
    content.push(renderPngImage("Icon", {
      x: (pageWidth - iconSize) / 2,
      y: pageHeight - marginY - iconSize,
      size: iconSize,
    }));
    y -= iconSize + iconGap;
  }

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
    images: icon ? [{ name: "Icon", ...icon }] : [],
  });
}

async function readPngIcon(iconPath) {
  if (!iconPath || !existsSync(iconPath)) return null;

  try {
    const image = decodePng(await readFile(iconPath));
    return {
      width: image.width,
      height: image.height,
      compressedRgb: deflateSync(image.rgb),
    };
  } catch {
    return null;
  }
}

function renderPngImage(name, placement) {
  return [
    "q",
    `${fixed(placement.size)} 0 0 ${fixed(placement.size)} ${fixed(placement.x)} ${fixed(placement.y)} cm`,
    `/${name} Do`,
    "Q",
  ].join("\n");
}

function decodePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("invalid PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  let palette = [];
  let transparency = Buffer.alloc(0);

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = [];
      for (let index = 0; index < data.length; index += 3) {
        palette.push([data[index], data[index + 1], data[index + 2]]);
      }
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error("only 8-bit non-interlaced PNG icons are supported");
  }

  const channels = pngChannels(colorType);
  const rowLength = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(width * height * channels);
  const rgb = Buffer.alloc(width * height * 3);
  const paper = [251, 249, 240];
  let sourceOffset = 0;

  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset++];
    const rowStart = row * rowLength;

    for (let column = 0; column < rowLength; column += 1) {
      const left = column >= channels ? raw[rowStart + column - channels] : 0;
      const up = row > 0 ? raw[rowStart + column - rowLength] : 0;
      const upLeft = row > 0 && column >= channels ? raw[rowStart + column - rowLength - channels] : 0;
      const value = inflated[sourceOffset++];
      raw[rowStart + column] = (value + pngPredictor(filter, left, up, upLeft)) & 0xff;
    }
  }

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 3;
    const rgba = pngPixel(raw, source, colorType, palette, transparency);
    const alpha = rgba[3] / 255;
    rgb[target] = Math.round(rgba[0] * alpha + paper[0] * (1 - alpha));
    rgb[target + 1] = Math.round(rgba[1] * alpha + paper[1] * (1 - alpha));
    rgb[target + 2] = Math.round(rgba[2] * alpha + paper[2] * (1 - alpha));
  }

  return { width, height, rgb };
}

function pngChannels(colorType) {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 3) return 1;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`unsupported PNG color type: ${colorType}`);
}

function pngPixel(raw, offset, colorType, palette, transparency) {
  if (colorType === 0) return [raw[offset], raw[offset], raw[offset], 255];
  if (colorType === 2) return [raw[offset], raw[offset + 1], raw[offset + 2], 255];
  if (colorType === 3) {
    const index = raw[offset];
    const color = palette[index] || [0, 0, 0];
    return [color[0], color[1], color[2], transparency[index] ?? 255];
  }
  if (colorType === 4) return [raw[offset], raw[offset], raw[offset], raw[offset + 1]];
  return [raw[offset], raw[offset + 1], raw[offset + 2], raw[offset + 3]];
}

function pngPredictor(filter, left, up, upLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  if (filter === 4) return paeth(left, up, upLeft);
  throw new Error(`unsupported PNG filter: ${filter}`);
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  if (upDistance <= upLeftDistance) return up;
  return upLeft;
}

function buildPdf({ pageWidth, pageHeight, content, images = [] }) {
  const xObjectResources = images.length > 0
    ? ` /XObject << ${images.map((image, index) => `/${image.name} ${index + 9} 0 R`).join(" ")} >>`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fixed(pageWidth)} ${fixed(pageHeight)}] /Resources << /Font << /FMono 5 0 R /FCjk 6 0 R >>${xObjectResources} >> /Contents 4 0 R >>`,
    pdfStream(Buffer.from(content, "utf8")),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [7 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 8 0 R >>",
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>",
    ...images.map((image) => pdfStream(image.compressedRgb, ` /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`)),
  ];

  const chunks = [Buffer.from("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n", "binary")];
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(bufferLength(chunks));
    chunks.push(Buffer.from(`${index + 1} 0 obj\n`, "utf8"));
    chunks.push(Buffer.isBuffer(object) ? object : Buffer.from(object, "utf8"));
    chunks.push(Buffer.from("\nendobj\n", "utf8"));
  });

  const xrefOffset = bufferLength(chunks);
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n`, "utf8"));
  chunks.push(Buffer.from("0000000000 65535 f \n", "utf8"));
  offsets.slice(1).forEach((offset) => {
    chunks.push(Buffer.from(`${String(offset).padStart(10, "0")} 00000 n \n`, "utf8"));
  });
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`, "utf8"));
  chunks.push(Buffer.from(`startxref\n${xrefOffset}\n%%EOF\n`, "utf8"));

  return Buffer.concat(chunks);
}

function pdfStream(data, dictionary = "") {
  return Buffer.concat([
    Buffer.from(`<<${dictionary} /Length ${data.length} >>\nstream\n`, "utf8"),
    data,
    Buffer.from("\nendstream", "utf8"),
  ]);
}

function bufferLength(chunks) {
  return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
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

function formatMoney(value) {
  return Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 4,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  });
}

function helpText() {
  return `
${PRODUCT_NAME}

Usage:
  tytr [codex|claude] [options]
  token-receipt [codex|claude] [options]
  node bin/tytr.mjs [codex|claude] [options]

Options:
  --latest                  Print the latest selected agent session receipt (default)
  --all                     Aggregate all selected agent sessions
  --provider <name>         Read from codex or claude logs
  --sessions-dir <path>     Read JSONL sessions from a custom directory
  --agent <name>            Agent name shown on the receipt
  --input-rate <usd>        Input price per 1M tokens, used only for cost estimate
  --output-rate <usd>       Output price per 1M tokens, used only for cost estimate
  --title-width <chars>     Session title width before wrapping/truncation (default: ${DEFAULT_TITLE_WIDTH})
  --save <path>             Save the receipt as a text file
  --pdf <path>              Save an 80mm receipt-style PDF
  --json                    Output machine-readable JSON instead of a receipt
  -h, --help                Show help

Examples:
  tytr
  tytr claude
  tytr --all
  tytr --all --pdf receipt-all.pdf
  tytr --save receipt.txt
  tytr --pdf receipt.pdf
  tytr claude --pdf claude-receipt.pdf
  tytr --input-rate 5 --output-rate 15
  tytr claude --input-rate 5 --output-rate 15 --pdf claude-priced.pdf
`.trim();
}
