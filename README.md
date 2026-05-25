# Take Your Token Receipt

`Take Your Token Receipt` is a tiny CLI that prints receipt-style token usage summaries from local Codex sessions.

Codex writes local sessions to `~/.codex/sessions/**/*.jsonl`. Those JSONL files include `token_count` events with real `last_token_usage` and `total_token_usage` values. This tool reads those files directly, so there is no browser UI, local HTTP server, or manual token entry.

## Quick Start

Run the latest-session receipt:

```bash
npm run receipt
```

Or call the CLI file directly:

```bash
node bin/tytr.mjs
```

After linking the package locally, use the shorter command:

```bash
npm link
tytr
```

## Commands

Latest Codex session:

```bash
tytr
```

All local Codex sessions:

```bash
tytr --all
```

Save a text receipt:

```bash
tytr --save receipt.txt
```

Save an 80mm receipt-style PDF:

```bash
tytr --pdf receipt.pdf
```

Estimate cost with per-1M-token prices:

```bash
tytr --input-rate 5 --output-rate 15
```

Output JSON for another script or printer pipeline:

```bash
tytr --json
```

Print with the system printer:

```bash
tytr --pdf receipt.pdf
lp receipt.pdf
```

## NPM Scripts

The package wraps the common commands:

```bash
npm start
npm run receipt
npm run receipt:all
npm run receipt:json
npm run receipt:priced
npm run receipt:save
npm run receipt:pdf
npm run check
```

## Options

- `--latest`: print the latest Codex session receipt, which is the default
- `--all`: aggregate every local Codex session
- `--sessions-dir <path>`: read Codex JSONL sessions from a custom directory
- `--agent <name>`: change the agent name printed on the receipt
- `--input-rate <usd>`: input price per 1M tokens, used only for cost estimation
- `--output-rate <usd>`: output price per 1M tokens, used only for cost estimation
- `--title-width <chars>`: session title width before wrapping/truncation, default `19`
- `--save <path>`: save the text receipt to a file
- `--pdf <path>`: save an 80mm receipt-style PDF
- `--json`: print structured JSON instead of the receipt
- `-h, --help`: show CLI help

## What The Receipt Shows
```Plain text
========================================
       TAKE YOUR TOKEN RECEIPT
========================================
   ____          _           
  / ___|___   __| | _____  __
 | |   / _ \ / _` |/ _ \ \/ /
 | |__| (_) | (_| |  __/>  < 
  \____\___/ \__,_|\___/_/\_\
----------------------------------------
Agent: Codex
Generated: 2026/5/25 16:43:05
Mode: latest Codex session
Model: gpt-5.5
Limit bucket: GPT-5.3-Codex-Spark
----------------------------------------
Sessions: 1
Turns: 2
Input tokens: 23,185
Cached input: 18,176
Output tokens: 70
Reasoning output: 0
Total tokens: 23,255
----------------------------------------
01. # Context from my I
    DE setup:
    2026/5/25 16:42:49 | 23,255 tokens
----------------------------------------
Keep this receipt for review and billing.
========================================
```

- Agent name and ASCII logo
- Generated time
- Latest or all-session mode
- Actual Codex model when it is present in the session log
- Codex rate-limit bucket when it is present in the token log
- Session count and turn count
- Input, cached input, output, reasoning output, and total tokens
- Optional estimated cost
- Recent session titles

## PDF Receipts

`--pdf` writes a narrow, receipt-shaped PDF while keeping the ASCII terminal output. ASCII-only lines use Courier so the logo keeps its shape. Lines with CJK characters use a built-in PDF CJK font mapping so local Codex titles can still appear in the generated PDF.

## Notes

- The default session directory is `~/.codex/sessions`.
- You can override it with `--sessions-dir <path>` or `CODEX_SESSIONS_DIR`.
- `Limit bucket` comes from Codex rate-limit metadata. It is not the same thing as the actual model.
- Cost estimation is optional and only uses the rates you pass in.
