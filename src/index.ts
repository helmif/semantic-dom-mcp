#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { closeBrowser } from "./browser.js";

/** One line a QA engineer can paste into a bug report: version, browser, config. */
function startupDiagnostic(): string {
  const require = createRequire(import.meta.url);
  const version = (require("../package.json") as { version: string }).version;
  const exe = chromium.executablePath();
  const hosts = (process.env.QA_MCP_ALLOWED_HOSTS ?? "").split(",").filter((h) => h.trim()).length;
  return (
    `v${version} connected over stdio | chromium ${existsSync(exe) ? "ok" : "MISSING (run: npx -y -p semantic-dom-mcp playwright install chromium)"} ` +
    `| allowed hosts: ${hosts || "NONE (set QA_MCP_ALLOWED_HOSTS)"} | storageState: ${process.env.QA_MCP_STORAGE_STATE ? "set" : "not set"}`
  );
}
import { closeAllSessions } from "./session.js";
import { createServer } from "./server.js";

async function shutdown(code: number): Promise<never> {
  await closeAllSessions().catch(() => undefined);
  await closeBrowser().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the MCP protocol; log only high-level events to stderr.
  console.error(`[semantic-dom-mcp] ${startupDiagnostic()}`);

  process.stdin.on("end", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

main().catch((err) => {
  console.error("[semantic-dom-mcp] fatal:", err);
  process.exit(1);
});
