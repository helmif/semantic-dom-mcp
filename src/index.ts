#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeBrowser } from "./browser.js";
import { createServer } from "./server.js";

async function shutdown(code: number): Promise<never> {
  await closeBrowser().catch(() => undefined);
  process.exit(code);
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout belongs to the MCP protocol; log only high-level events to stderr.
  console.error("[semantic-dom-mcp] server connected over stdio");

  process.stdin.on("end", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
}

main().catch((err) => {
  console.error("[semantic-dom-mcp] fatal:", err);
  process.exit(1);
});
