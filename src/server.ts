import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkAuth, extractAfterActions, extractSemanticDom, listFrames, ExtractError } from "./browser.js";
import { renderWritePlaywrightTestPrompt, TEAM_CONVENTIONS } from "./conventions.js";

/**
 * Input schema for `extract_semantic_dom`.
 * `.strict()` rejects unknown keys and advertises `additionalProperties: false`
 * in the tool's JSON schema (inputs arrive via an LLM and are untrusted).
 */
const extractInputSchema = z
  .object({
    url: z
      .string()
      .describe("The page to extract. Must be http/https and on an allowlisted host."),
    wait_for: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("networkidle")
      .describe("Navigation wait condition."),
    wait_selector: z
      .string()
      .optional()
      .describe("Optional selector to await before extracting (for SPA content)."),
    include_hidden: z
      .boolean()
      .default(true)
      .describe("Keep hidden nodes flagged rather than dropping them."),
    max_nodes: z
      .number()
      .int()
      .positive()
      .default(5000)
      .describe("Cap on extracted nodes; truncation is flagged, never silent."),
    viewport: z
      .enum(["desktop", "mobile"])
      .default("desktop")
      .describe("Viewport preset — 'mobile' is 375x812 with touch, for responsive states."),
  })
  .strict();

const actionLocatorSchema = z
  .object({
    strategy: z
      .enum(["test-id", "role", "label", "placeholder", "text", "id", "css"])
      .describe("Locator strategy, matching the strategies in extraction output."),
    value: z.string().min(1).describe("The locator value (test id, accessible name, label, selector...)."),
    role: z.string().optional().describe("ARIA role — required when strategy is 'role'."),
    nth: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Optional .nth(i) index from the extraction's disambiguation guidance."),
  })
  .strict();

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("fill"), locator: actionLocatorSchema, value: z.string() }).strict(),
  z.object({ type: z.literal("click"), locator: actionLocatorSchema }).strict(),
  z.object({ type: z.literal("press"), locator: actionLocatorSchema, key: z.string().max(30) }).strict(),
  z.object({ type: z.literal("wait"), ms: z.number().int().positive().max(10_000) }).strict(),
]);

const extractAfterInputSchema = extractInputSchema
  .extend({
    actions: z
      .array(actionSchema)
      .min(1)
      .max(20)
      .describe("Declared actions executed in order in the MAIN frame after navigation."),
    settle_ms: z
      .number()
      .int()
      .nonnegative()
      .max(10_000)
      .default(500)
      .describe("Wait after the last action before snapshotting (for toasts/animations)."),
  })
  .strict();

const listFramesInputSchema = z
  .object({
    url: z.string().describe("The page whose frame tree to report. Must be http/https and allowlisted."),
    wait_for: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .default("networkidle")
      .describe("Navigation wait condition."),
  })
  .strict();

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Structured error in content so the agent can react, not crash. */
function errorResult(err: unknown): ToolResult {
  const body =
    err instanceof ExtractError
      ? { error: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }
      : { error: "internal_error", message: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

const SERVER_INSTRUCTIONS =
  "Always call `extract_semantic_dom` before writing a Playwright test; then use the " +
  "`write_playwright_test` prompt (or read conventions://playwright) so the test follows team " +
  "conventions. Never author locators from memory — use only the `playwright` expressions " +
  "returned by the extraction.";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "semantic-dom-mcp", version: "0.3.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "extract_semantic_dom",
    {
      description:
        "Navigate to a staging URL and return factual Semantic JSON of all interactive/test-relevant elements " +
        "with Playwright-native locators and live state. Use this before writing any Playwright test so " +
        "selectors are real, not guessed.",
      inputSchema: extractInputSchema,
    },
    async (args) => {
      try {
        return jsonResult(await extractSemanticDom(args));
      } catch (err) {
        console.error(`[semantic-dom-mcp] extract failed: ${err instanceof ExtractError ? err.code : "internal_error"}`);
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "extract_semantic_dom_after",
    {
      description:
        "Like extract_semantic_dom, but first performs a short DECLARED list of actions " +
        "(fill/click/press/wait) in the main frame, then returns Semantic JSON of the RESULTING state. " +
        "Use it for post-interaction UI a plain snapshot cannot see: success/error toasts, validation " +
        "messages, opened dialogs. Derive action locators from a prior extract_semantic_dom call. " +
        "The page must remain on allowlisted hosts after the actions, or nothing is extracted.",
      inputSchema: extractAfterInputSchema,
    },
    async (args) => {
      try {
        return jsonResult(await extractAfterActions(args));
      } catch (err) {
        console.error(
          `[semantic-dom-mcp] extract_after failed: ${err instanceof ExtractError ? err.code : "internal_error"}`,
        );
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_frames",
    {
      description:
        "Diagnostic: navigate to a URL and return its frame tree (frame_path, url, name, same_origin, " +
        "reachable). Useful for debugging cross-origin iframe boundaries before extraction.",
      inputSchema: listFramesInputSchema,
    },
    async (args) => {
      try {
        return jsonResult({ url: args.url, frames: await listFrames(args.url, args.wait_for) });
      } catch (err) {
        console.error(`[semantic-dom-mcp] list_frames failed: ${err instanceof ExtractError ? err.code : "internal_error"}`);
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "check_auth",
    {
      description:
        "Diagnostic: navigates with the configured QA_MCP_STORAGE_STATE session and reports whether " +
        "the page bounced to a login-looking path (session likely expired). Use when extractions " +
        "unexpectedly return login forms instead of the requested page.",
      inputSchema: listFramesInputSchema,
    },
    async (args) => {
      try {
        return jsonResult(await checkAuth(args.url, args.wait_for));
      } catch (err) {
        console.error(`[semantic-dom-mcp] check_auth failed: ${err instanceof ExtractError ? err.code : "internal_error"}`);
        return errorResult(err);
      }
    },
  );

  server.registerPrompt(
    "write_playwright_test",
    {
      description:
        "Team-standard prompt for writing a Playwright test in TypeScript from a Semantic DOM extraction. " +
        "Ensures every engineer gets identical conventions: locator usage, frame chaining, structure, " +
        "assertions, and single-snapshot state honesty.",
      argsSchema: {
        scenario: z.string().describe("What to test, in plain language."),
        extract_json: z.string().describe("The Semantic JSON returned by extract_semantic_dom."),
        team_name: z.string().optional().describe("Team name; defaults to QA_MCP_TEAM_NAME or 'QA'."),
        framework_note: z.string().optional().describe("Optional note about the target test framework setup."),
      },
    },
    (args) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: renderWritePlaywrightTestPrompt(args) },
        },
      ],
    }),
  );

  server.registerResource(
    "playwright-conventions",
    "conventions://playwright",
    {
      title: "Team Playwright conventions",
      description: "The team's non-negotiable Playwright test-writing conventions (read-only).",
      mimeType: "text/plain",
    },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: TEAM_CONVENTIONS }],
    }),
  );

  return server;
}
