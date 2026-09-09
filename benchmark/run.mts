/**
 * Benchmark: what an AI agent receives WITH semantic-dom-mcp vs WITHOUT it.
 *
 * For each URL this measures, using only what is already in the repo (no new
 * dependencies):
 *
 *  1. Payload size — raw `page.content()` HTML (what you get if you paste the
 *     DOM at an agent), a "cleaned" HTML baseline (scripts/styles/svg/meta
 *     stripped, whitespace collapsed — the fairest manual alternative), and
 *     the Semantic JSON the tool returns. Token counts are estimated at
 *     4 chars/token; exact tokenization varies by model, so raw char counts
 *     are reported too.
 *  2. Locator evidence — node count, how many primaries are verified-unique,
 *     and whether every non-unique primary carries disambiguation guidance
 *     (the "no unflagged ambiguity" invariant).
 *  3. Determinism — two extractions compared with captured_at stripped.
 *     Identical output is what makes results consistent across engineers.
 *  4. Extraction wall time.
 *
 * Usage:  npm run bench -- <url> [url ...]
 * Writes benchmark/RESULTS.md and prints a summary.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { extractOutline, extractSemanticDom, closeBrowser, trackSettle } from "../src/browser.js";
import { compactForWire } from "../src/compact.js";
import type { SemanticExtract } from "../src/types.js";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: npm run bench -- <url> [url ...]");
  process.exit(1);
}
if (!process.env.QA_MCP_ALLOWED_HOSTS) {
  process.env.QA_MCP_ALLOWED_HOSTS = [...new Set(urls.map((u) => new URL(u).hostname))].join(",");
}

const estTokens = (chars: number): number => Math.round(chars / 4);
const cell = (s: string): string => s.replace(/\|/g, "\\|");
const fmt = (n: number): string => n.toLocaleString("en-US");
const reduction = (small: number, big: number): string => `${(100 * (1 - small / big)).toFixed(1)}%`;

interface Row {
  url: string;
  title: string;
  rawChars: number;
  cleanedChars: number;
  /** Playwright's aria snapshot of <body>: the native accessibility representation browser tools give an agent. */
  ariaChars: number;
  outlineChars: number;
  outlineMs: number;
  jsonChars: number;
  nodes: number;
  uniquePrimaries: number;
  flaggedAmbiguous: number;
  unflaggedAmbiguous: number;
  deterministic: boolean;
  extractMs: number;
}

/**
 * Parity with the MCP arm: same storageState (QA_MCP_STORAGE_STATE), same
 * wait (load + settled). Also captures Playwright's aria snapshot, the
 * closest public equivalent of the accessibility tree that native browser
 * tools (Playwright MCP, Codex/Claude browser tools) hand an agent.
 */
async function captureRawHtml(url: string): Promise<{ raw: string; cleaned: string; aria: string }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const storageState = process.env.QA_MCP_STORAGE_STATE;
    if (storageState && !existsSync(storageState)) throw new Error(`QA_MCP_STORAGE_STATE '${storageState}' does not exist`);
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();
    const settle = trackSettle(page);
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await settle.wait();
    const raw = await page.content();
    const cleaned = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script,style,svg,noscript,link,meta,template").forEach((e) => e.remove());
      return clone.outerHTML.replace(/\s+/g, " ");
    });
    const aria = await page.locator("body").ariaSnapshot();
    return { raw, cleaned, aria };
  } finally {
    await browser.close();
  }
}

function stripVolatile(extract: SemanticExtract): unknown {
  return {
    ...extract,
    page_metadata: { ...extract.page_metadata, captured_at: "<stripped>" },
  };
}

const rows: Row[] = [];
for (const url of urls) {
  console.error(`\n=== ${url}`);
  const { raw, cleaned, aria } = await captureRawHtml(url);

  const tOutline = Date.now();
  const outline = await extractOutline({ url, wait_for: "auto" });
  const outlineMs = Date.now() - tOutline;
  const outlineChars = JSON.stringify(outline).length;

  const t0 = Date.now();
  const first = await extractSemanticDom({
    url,
    wait_for: "auto",
    include_hidden: true,
    max_nodes: 5000,
  });
  const extractMs = Date.now() - t0;
  const second = await extractSemanticDom({
    url,
    wait_for: "auto",
    include_hidden: true,
    max_nodes: 5000,
  });

  // Optional anonymized labels for the committed report (comma-separated,
  // matched to URL order), e.g. QA_BENCH_LABELS="Home (SPA),Product detail".
  const labels = (process.env.QA_BENCH_LABELS ?? "").split(",").map((s) => s.trim());
  const label = labels[urls.indexOf(url)] || first.page_metadata.title;

  const json = JSON.stringify(compactForWire(first)); // schema 1.3 wire = the actual tool payload
  const deterministic =
    JSON.stringify(stripVolatile(first)) === JSON.stringify(stripVolatile(second));

  let uniquePrimaries = 0;
  let flaggedAmbiguous = 0;
  let unflaggedAmbiguous = 0;
  for (const n of first.interactive_nodes) {
    if (n.primary_locator.is_unique) uniquePrimaries++;
    else if (n.primary_locator.disambiguation) flaggedAmbiguous++;
    else unflaggedAmbiguous++;
  }

  rows.push({
    url,
    title: label,
    rawChars: raw.length,
    cleanedChars: cleaned.length,
    ariaChars: aria.length,
    outlineChars,
    outlineMs,
    jsonChars: json.length,
    nodes: first.page_metadata.node_count,
    uniquePrimaries,
    flaggedAmbiguous,
    unflaggedAmbiguous,
    deterministic,
    extractMs,
  });
  console.error(
    `raw ${fmt(raw.length)} ch | cleaned ${fmt(cleaned.length)} ch | aria ${fmt(aria.length)} ch | outline ${fmt(outlineChars)} ch (${outlineMs}ms) | semantic ${fmt(json.length)} ch | ` +
      `${first.page_metadata.node_count} nodes | deterministic=${deterministic} | ${extractMs}ms`,
  );
}
await closeBrowser();

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

const lines: string[] = [];
lines.push("# Benchmark results — semantic-dom-mcp vs raw DOM");
lines.push("");
lines.push(`_Generated ${new Date().toISOString()} by \`npm run bench\`. Token counts are estimated at 4 chars/token; char counts are exact — re-tokenize with your model's tokenizer for precise figures._`);
lines.push("");
lines.push("## Context payload an agent must consume");
lines.push("");
lines.push("| Page | Raw HTML | Cleaned HTML¹ | Aria snapshot² | Outline (v0.8) | Full Semantic JSON | Outline vs aria | Full vs cleaned |");
lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  lines.push(
    `| ${cell(r.title)} | ${fmt(r.rawChars)} ch (~${fmt(estTokens(r.rawChars))} tok) | ${fmt(r.cleanedChars)} ch (~${fmt(estTokens(r.cleanedChars))} tok) | ${fmt(r.ariaChars)} ch (~${fmt(estTokens(r.ariaChars))} tok) | ${fmt(r.outlineChars)} ch (~${fmt(estTokens(r.outlineChars))} tok) | ${fmt(r.jsonChars)} ch (~${fmt(estTokens(r.jsonChars))} tok) | **${reduction(r.outlineChars, r.ariaChars)}** | **${reduction(r.jsonChars, r.cleanedChars)}** |`,
  );
}
lines.push("");
lines.push("¹ Scripts, styles, svg, meta and whitespace stripped — the fairest manual alternative to pasting the DOM.");
lines.push("");
lines.push("² Playwright's `ariaSnapshot()` of `<body>`: the accessibility-tree representation native browser tools give an agent. It carries no locators, no state and no verification; the outline is the MCP's comparable first look, from which the agent scopes a full extraction to one region. Both arms use the same storageState and the same load-then-settled wait.");
lines.push("");
lines.push("## Locator evidence (the accuracy layer)");
lines.push("");
lines.push("| Page | Interactive nodes | Verified-unique primaries | Ambiguous + flagged with guidance | Ambiguous + UNFLAGGED |");
lines.push("| --- | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  lines.push(`| ${cell(r.title)} | ${r.nodes} | ${r.uniquePrimaries} | ${r.flaggedAmbiguous} | ${r.unflaggedAmbiguous} |`);
}
lines.push("");
lines.push("Every returned locator was match-counted by Playwright's own engine before being emitted. The UNFLAGGED column must always be 0 — a non-unique locator without guidance is the #1 cause of flaky tests.");
lines.push("");
lines.push("## Consistency & speed");
lines.push("");
lines.push("| Page | Two extractions identical (captured_at excluded) | Extraction time |");
lines.push("| --- | :---: | ---: |");
for (const r of rows) {
  lines.push(`| ${cell(r.title)} | ${r.deterministic ? "yes" : "**NO — investigate**"} | ${(r.extractMs / 1000).toFixed(1)}s |`);
}
lines.push("");
lines.push("Identical output for identical page state is what makes two engineers (or the same engineer on two days) start from the same facts. Any drift here comes from the page itself changing between runs, and would hit a raw-HTML workflow far harder.");
lines.push("");
lines.push("## What this benchmark does NOT show");
lines.push("");
lines.push("- **Test quality uplift.** Whether agents write better tests with Semantic JSON needs an A/B protocol with human grading — see benchmark/README.md.");
lines.push("- **Selector hallucination in the raw-HTML condition.** By construction the MCP path cannot invent selectors; the raw path can. Measure it via the A/B protocol.");

const out = join(dirname(fileURLToPath(import.meta.url)), "RESULTS.md");
writeFileSync(out, lines.join("\n") + "\n");
console.error(`\nwrote ${out}`);
