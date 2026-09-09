import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkAuth, extractAfterActions, extractOutline, extractSemanticDom, listFrames, verifyLocators, ExtractError } from "./browser.js";
import { renderWritePlaywrightTestPrompt, TEAM_CONVENTIONS } from "./conventions.js";
import { compactForWire } from "./compact.js";
import { redactString } from "./secrets.js";
import { actInSession, closeSession, extractInSession, listSessions, openSession, verifyInSession } from "./session.js";

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
      .enum(["auto", "load", "domcontentloaded", "networkidle"])
      .default("auto")
      .describe(
        "Navigation wait. 'auto' (default) waits for load, then until the DOM has been quiet for 500ms (max 6s) — " +
          "works on SPAs that render after load and on pages whose analytics never let the network go idle. " +
          "'networkidle' times out on such pages.",
      ),
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
    include_click_targets: z
      .boolean()
      .default(false)
      .describe(
        "Opt-in heuristic: also include cursor:pointer elements with content that match no other rule " +
          "(JS-click product cards without anchors/roles/test-ids). Heuristic nodes carry a context_note.",
      ),
    scope: z
      .string()
      .optional()
      .describe("CSS selector to extract within — take it from an outline region's `selector` (e.g. 'main table', '[role=\"dialog\"]'). Everything outside is skipped."),
    roles: z
      .array(z.string())
      .optional()
      .describe("Keep only nodes with these roles or tags (e.g. ['button','textbox','row'])."),
    visible_only: z.boolean().default(false).describe("Skip hidden nodes entirely."),
    max_output_chars: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Budget for the node list; nodes past it are dropped in document order and counted in `omitted` (never silent)."),
    include_tables: z
      .boolean()
      .default(false)
      .describe("Attach structured `tables` (headers, row identity, cells) and `dialogs` (label/value fields) inside the scope, for value assertions."),
  })
  .strict();

const outlineInputSchema = extractInputSchema.pick({ url: true, wait_for: true, wait_selector: true, viewport: true, scope: true }).strict();

const verifyInputSchema = extractInputSchema
  .pick({ url: true, wait_for: true, wait_selector: true, viewport: true })
  .extend({
    locators: z
      .array(z.string().min(1))
      .min(1)
      .max(200)
      .describe("Playwright expressions as written in the test (getByRole(...), getByTestId(...), scoped forms, .nth(i))."),
  })
  .strict();

const actionLocatorSchema = z
  .object({
    playwright: z
      .string()
      .min(1)
      .optional()
      .describe("A `playwright` expression exactly as an extraction returned it (scoped forms and .nth included). When given, strategy/value are not needed."),
    strategy: z
      .enum(["test-id", "role", "label", "placeholder", "text", "id", "css"])
      .default("css")
      .describe("Locator strategy, matching the strategies in extraction output (ignored when `playwright` is given)."),
    value: z.string().default("").describe("The locator value (test id, accessible name, label, selector...). Empty for a bare role inside `within`."),
    role: z.string().optional().describe("ARIA role — required when strategy is 'role'."),
    within: z
      .object({ kind: z.enum(["row", "listitem", "test-id", "css"]), value: z.string().min(1) })
      .strict()
      .optional()
      .describe("Scope to a container first; copy the extraction's `within` verbatim."),
    nth: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Optional .nth(i) index from the extraction's disambiguation guidance."),
  })
  .strict()
  .refine((l) => l.playwright !== undefined || l.value !== "" || l.strategy === "role", {
    message: "Give either `playwright` (an expression from an extraction) or strategy + value.",
  });

const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("fill"),
      locator: actionLocatorSchema,
      value: z.string(),
      secret: z
        .boolean()
        .optional()
        .describe("Mark the value as a secret: it is scrubbed from every string the server returns. Password fields are detected automatically."),
    })
    .strict(),
  z.object({ type: z.literal("click"), locator: actionLocatorSchema }).strict(),
  z.object({ type: z.literal("press"), locator: actionLocatorSchema, key: z.string().max(30) }).strict(),
  z
    .object({ type: z.literal("select"), locator: actionLocatorSchema, value: z.string() })
    .strict()
    .describe("Choose a <select> option by value or label."),
  z
    .object({ type: z.literal("goto"), url: z.string() })
    .strict()
    .describe("Navigate within the flow (must be http/https and allowlisted)."),
  z.object({ type: z.literal("wait"), ms: z.number().int().positive().max(10_000) }).strict(),
]);

const extractAfterInputSchema = extractInputSchema
  .extend({
    actions: z
      .array(actionSchema)
      .min(1)
      .max(20)
      .describe("Declared actions (fill/click/press/select/goto/wait) executed in order in the MAIN frame after navigation."),
    settle_ms: z
      .number()
      .int()
      .nonnegative()
      .max(10_000)
      .default(500)
      .describe("Wait after the last action before snapshotting (for toasts/animations)."),
    wait_selector_after: z
      .string()
      .optional()
      .describe(
        "Selector to await (visible) AFTER the actions, before snapshotting — deterministic wait for late-rendering toasts/modals instead of guessing settle_ms.",
      ),
  })
  .strict();

const listFramesInputSchema = z
  .object({
    url: z.string().describe("The page whose frame tree to report. Must be http/https and allowlisted."),
    wait_for: z.enum(["auto", "load", "domcontentloaded", "networkidle"]).default("auto").describe("Navigation wait; see extract_semantic_dom."),
  })
  .strict();

// Session schemas reuse the single-shot field definitions (same bounds,
// defaults and descriptions) so the two surfaces cannot drift apart.
const sessionIdField = z.string().describe("From session_open.");

const sessionOpenInputSchema = extractInputSchema
  .pick({ url: true, wait_for: true, wait_selector: true, viewport: true })
  .strict();

const sessionExtractOptions = extractInputSchema
  .pick({ include_hidden: true, max_nodes: true, include_click_targets: true, scope: true, roles: true, visible_only: true, max_output_chars: true, include_tables: true })
  .extend({
    diff_against: z
      .union([z.number().int().positive(), z.literal("previous")])
      .optional()
      .describe(
        "Return only what changed since that snapshot_id (or 'previous' = the last snapshot in this session) " +
          "instead of the full extraction — added/removed/changed nodes plus the behavior observed in between.",
      ),
    mode: z
      .enum(["nodes", "outline"])
      .default("nodes")
      .describe("'outline': the page as a map (regions with `selector`, structured tables, dialogs, alerts) in a few thousand characters; does not consume a snapshot id."),
  });

const sessionActInputSchema = extractAfterInputSchema
  .pick({ actions: true, settle_ms: true, wait_selector_after: true })
  .extend({
    session_id: sessionIdField,
    then_extract: sessionExtractOptions
      .extend({ mode: z.enum(["diff", "nodes", "outline"]).default("diff").describe("'diff' (default): what changed since the previous snapshot.") })
      .strict()
      .optional()
      .describe("Also snapshot in this call — one round trip per step. Default mode 'diff' against the previous snapshot; supports scope/roles/visible_only/max_output_chars/include_tables."),
  })
  .strict();

const sessionVerifyInputSchema = z
  .object({ session_id: sessionIdField, locators: verifyInputSchema.shape.locators })
  .strict();

const sessionExtractInputSchema = sessionExtractOptions
  .extend({
    session_id: sessionIdField,
  })
  .strict();

const sessionIdInputSchema = z.object({ session_id: z.string() }).strict();

/** Tools that only read the page. Sessions and the after-tool mutate page state (declared actions) but never the outside world. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Reads the page but consumes session state (snapshot id, recording): safe, not repeatable. */
const READS_CONSUMES = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const ACTS_ON_PAGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Every result leaves the server compacted (schema 1.3 wire rules, no
 * indentation) and with secrets redacted. Indentation alone was a third of
 * the tokens; the wire rules take most of the rest.
 */
function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: redactString(JSON.stringify(compactForWire(value))) }] };
}

/** Structured error in content so the agent can react, not crash. */
function errorResult(err: unknown): ToolResult {
  const body =
    err instanceof ExtractError
      ? { error: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) }
      : { error: "internal_error", message: err instanceof Error ? err.message.split("\n")[0] : String(err) };
  return { isError: true, content: [{ type: "text", text: redactString(JSON.stringify(body)) }] };
}

/** One handler shape for every tool: JSON on success, structured error + one stderr line on failure. */
function guarded<A>(name: string, fn: (args: A) => Promise<unknown>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return jsonResult(await fn(args));
    } catch (err) {
      console.error(`[semantic-dom-mcp] ${name} failed: ${err instanceof ExtractError ? err.code : "internal_error"}`);
      return errorResult(err);
    }
  };
}

const SERVER_INSTRUCTIONS =
  "Start cheap: `extract_outline` (or session_extract mode:'outline') maps the page — regions with a `selector`, " +
  "structured tables (row identity + cells) and dialogs (label/value fields) — in a few thousand characters. Then " +
  "extract only the region you need with `scope` (plus roles/visible_only/max_output_chars), and act with " +
  "`session_act` passing `then_extract` so each step is one round trip. Paste any returned `playwright` expression " +
  "back as an action locator (`locator: { playwright: \"...\" }`); no re-parsing. After writing the test, run " +
  "`verify_locators` with the expressions in the spec. " +
  "Output is compact JSON (schema 1.5). An absent node property is null (not applicable; never read it as false). " +
  "A locator with `within` is scoped to a container (a table row by name, a list item by text, or a test-id " +
  "ancestor); its `playwright` expression is complete, and an action locator takes the same `within` verbatim. " +
  "Absent frame_path = main document, absent in_shadow = light DOM, absent fallback_locators = nothing worth " +
  "listing (rely on primary_locator.is_unique). " +
  "Always extract before writing a Playwright test; never author locators from memory — use only the " +
  "`playwright` expressions returned by an extraction. Single page: `extract_semantic_dom`. " +
  "Multi-step flow (login → cart → checkout): `session_open`, then alternate `session_act` (declared " +
  "actions; returns the navigations/requests/console errors observed) and `session_extract` (use " +
  "`diff_against: 'previous'` to get only what changed — that is your assertion list), then " +
  "`session_close`. Use the `write_playwright_test` prompt (or read conventions://playwright) so the " +
  "test follows team conventions; `observed.navigations` feed waitForURL and `observed.requests` feed " +
  "waitForResponse.";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "semantic-dom-mcp", version: "0.8.0" },
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
      annotations: READ_ONLY,
    },
    guarded("extract_semantic_dom", extractSemanticDom),
  );

  server.registerTool(
    "extract_semantic_dom_after",
    {
      description:
        "Like extract_semantic_dom, but first performs a short DECLARED list of actions " +
        "(fill/click/press/select/goto/wait) in the main frame, then returns Semantic JSON of the RESULTING state. " +
        "Use it for post-interaction UI a plain snapshot cannot see: success/error toasts, validation " +
        "messages, opened dialogs. Derive action locators from a prior extract_semantic_dom call. " +
        "The page must remain on allowlisted hosts after the actions, or nothing is extracted. " +
        "Uniqueness reflects capture time — accumulating UI (chat threads, lists) can multiply matches later. " +
        "The result's `observed` block lists navigations, xhr/fetch requests (method, path, status), console " +
        "errors, dialogs and popups seen while the actions ran — use them for waitForURL/waitForResponse.",
      inputSchema: extractAfterInputSchema,
      annotations: ACTS_ON_PAGE,
    },
    guarded("extract_semantic_dom_after", extractAfterActions),
  );

  server.registerTool(
    "list_frames",
    {
      description:
        "Diagnostic: navigate to a URL and return its frame tree (frame_path, url, name, same_origin, " +
        "reachable). Useful for debugging cross-origin iframe boundaries before extraction.",
      inputSchema: listFramesInputSchema,
      annotations: READ_ONLY,
    },
    guarded("list_frames", async (args) => ({ url: args.url, frames: await listFrames(args.url, args.wait_for) })),
  );

  server.registerTool(
    "check_auth",
    {
      description:
        "Diagnostic: navigates with the configured QA_MCP_STORAGE_STATE session and reports whether " +
        "the page bounced to a login-looking path (session likely expired). Use when extractions " +
        "unexpectedly return login forms instead of the requested page.",
      inputSchema: listFramesInputSchema,
      annotations: READ_ONLY,
    },
    guarded("check_auth", (args) => checkAuth(args.url, args.wait_for)),
  );

  server.registerTool(
    "extract_outline",
    {
      description:
        "The page as a MAP, a few thousand characters: landmark regions (header/nav/main/forms/tables/lists/dialogs) each " +
        "with a `selector` you can pass as `scope` to extract_semantic_dom / session_extract, structured tables " +
        "(headers, row identity for getByRole('row', { name }), cells) and open dialogs (label/value fields), plus " +
        "current alert text. Start here on any page you have not seen; then extract one region.",
      inputSchema: outlineInputSchema,
      annotations: READ_ONLY,
    },
    guarded("extract_outline", extractOutline),
  );

  server.registerTool(
    "verify_locators",
    {
      description:
        "Count every given Playwright expression against the live page (same engine that verified the extraction). " +
        "Use after writing a test: paste the spec's getBy*/locator expressions and get matches, uniqueness, and the " +
        "first matched element per expression, plus a summary. Also the drift check to run in CI against a page.",
      inputSchema: verifyInputSchema,
      annotations: READ_ONLY,
    },
    guarded("verify_locators", verifyLocators),
  );

  server.registerTool(
    "get_conventions",
    {
      description: "The team's Playwright test-writing conventions as text (same content as the write_playwright_test prompt), for clients that do not surface MCP prompts.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    guarded("get_conventions", async () => ({ conventions: TEAM_CONVENTIONS })),
  );

  /* ---------------- sessions (v0.5: flows, not pages) ---------------- */

  server.registerTool(
    "session_open",
    {
      description:
        "Open a persistent browser session at a staging URL for a MULTI-STEP flow (login → cart → checkout). " +
        "The page stays open across calls: use session_act to perform declared actions and session_extract to " +
        "snapshot or diff, then session_close. Fresh context per session (storageState applied if configured). " +
        "Sessions expire after an idle TTL and are capped in number; the allowlist is re-checked after every step.",
      inputSchema: sessionOpenInputSchema,
      annotations: ACTS_ON_PAGE,
    },
    guarded("session_open", openSession),
  );

  server.registerTool(
    "session_act",
    {
      description:
        "Perform a short DECLARED action list (fill/click/press/select/goto/wait, max 20) in an open session's " +
        "main frame. Returns the page's resulting URL/title and `observed`: main-frame navigations, xhr/fetch " +
        "requests (method, path, status — bodies and query strings never captured), console errors, dialogs " +
        "(auto-dismissed) and popups (recorded, closed). These are the facts for waitForURL/waitForResponse. " +
        "Derive action locators from a prior extraction (paste its `playwright` expression). Pass `then_extract` to get " +
        "the diff (or a scoped extraction / outline) in the same call. If the actions leave the allowlisted hosts the " +
        "session is closed and nothing further is extracted.",
      inputSchema: sessionActInputSchema,
      annotations: ACTS_ON_PAGE,
    },
    guarded("session_act", actInSession),
  );

  server.registerTool(
    "session_extract",
    {
      description:
        "Snapshot the CURRENT state of an open session as Semantic JSON (same shape as extract_semantic_dom, " +
        "plus `snapshot_id`). Pass `diff_against: 'previous'` (or a snapshot_id) to receive only what changed: " +
        "added nodes (new toasts/dialogs/fields), removed nodes, changed properties (value, is_disabled, " +
        "aria_invalid, described_by…) and the behavior observed in between — far smaller than a full " +
        "re-extraction and exactly the assertion list for the step. Diff identity: frame + test-id, else id, " +
        "else placeholder, else tag+role+accessible name (+ document-order index); a renamed node with no stable " +
        "attribute shows as removed + added; primary_locator.playwright changes say which locator is valid in which state.",
      inputSchema: sessionExtractInputSchema,
      annotations: READS_CONSUMES,
    },
    guarded("session_extract", extractInSession),
  );

  server.registerTool(
    "session_verify_locators",
    {
      description: "verify_locators against an open session's current page (after acting, without a fresh navigation).",
      inputSchema: sessionVerifyInputSchema,
      annotations: READ_ONLY,
    },
    guarded("session_verify_locators", (args) => verifyInSession(args.session_id, args.locators)),
  );

  server.registerTool(
    "session_close",
    {
      description:
        "Close an open session and release its browser context. Always call this when the flow is done. " +
        "Idempotent: closing an unknown or already-closed id succeeds with was_open: false.",
      inputSchema: sessionIdInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guarded("session_close", (args) => closeSession(args.session_id)),
  );

  server.registerTool(
    "session_list",
    {
      description: "Diagnostic: list open sessions (id, URL, expiry, counts) — recover a session id after losing context.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ONLY,
    },
    guarded("session_list", () => listSessions()),
  );

  server.registerPrompt(
    "write_playwright_test",
    {
      description:
        "Team-standard prompt for writing a Playwright test in TypeScript from a Semantic DOM extraction or a session diff. " +
        "Ensures every engineer gets identical conventions: locator usage, frame chaining, structure, " +
        "assertions, and single-snapshot state honesty.",
      argsSchema: {
        scenario: z.string().describe("What to test, in plain language."),
        extract_json: z
          .string()
          .describe("The Semantic JSON from extract_semantic_dom / session_extract, or a session diff (kind: 'diff')."),
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
