# semantic-dom-mcp

Local MCP server (stdio, Node.js + TypeScript) that drives a real Chromium browser via Playwright
to extract a live page, or a whole multi-step flow, into compact, factual **Semantic JSON** with
**Playwright-native locators**, the **behavior the page showed** (navigations, requests, console
errors), and **diffs between steps**. AI-generated Playwright tests come out consistent across the
whole QA team, not just accurate.

Same page → same extraction → same conventions → same test style, regardless of who runs it.

**Evidence:** [benchmark/RESULTS.md](https://github.com/helmif/semantic-dom-mcp/blob/main/benchmark/RESULTS.md). On real pages the Semantic JSON is
**92–97% smaller** than the raw DOM an agent would otherwise consume, every locator is
uniqueness-verified by Playwright's engine, and output is byte-identical across runs. A session
diff is a further **~90% smaller** than re-extracting the page after a step.
**Docs:** [How it works (deep dive)](https://github.com/helmif/semantic-dom-mcp/blob/main/docs/HOW-IT-WORKS.md) · [Team guide (setup + connecting your agent)](https://github.com/helmif/semantic-dom-mcp/blob/main/docs/GUIDE.md) · [Benchmark methodology](https://github.com/helmif/semantic-dom-mcp/blob/main/benchmark/README.md) · [v0.5 flow validation](https://github.com/helmif/semantic-dom-mcp/blob/main/benchmark/FLOW-VALIDATION.md) · [Roadmap](https://github.com/helmif/semantic-dom-mcp/blob/main/docs/ROADMAP.md) · [Changelog](https://github.com/helmif/semantic-dom-mcp/blob/main/CHANGELOG.md)

## Quickstart

No clone, no build — the package is on npm. One-time browser setup (installs the
Chromium build matching the package's bundled Playwright):

```bash
npx -y -p semantic-dom-mcp playwright install chromium
```

Then add the server to your MCP client:

```json
{
  "mcpServers": {
    "semantic-dom": {
      "command": "npx",
      "args": ["-y", "semantic-dom-mcp"],
      "env": {
        "QA_MCP_ALLOWED_HOSTS": "staging.yourapp.internal,staging.admin.internal",
        "QA_MCP_STORAGE_STATE": "./.auth/staging.json"
      }
    }
  }
}
```

That's the whole setup. Verify by asking your agent to list its MCP tools — you should
see `extract_semantic_dom`. See [docs/GUIDE.md](https://github.com/helmif/semantic-dom-mcp/blob/main/docs/GUIDE.md) for per-client config
locations (Claude Code, Claude Desktop, Cursor, Windsurf), authenticated staging, and
troubleshooting. To run from a clone instead (contributors), see Development below.

## Workflow

**Single page.** Ask your agent: *"extract the checkout page and write a success-path test."*

1. The agent calls **`extract_semantic_dom({ url })`**. The server navigates a real Chromium
   page, runs the extractor inside it, and returns Semantic JSON: every interactive node with a
   ready-to-paste Playwright locator, uniqueness verified by Playwright's own engine.
2. The agent uses the **`write_playwright_test`** prompt (scenario + the JSON), which injects the
   team conventions.
3. The result is a Playwright test in team style, grounded in real locators, never guessed ones.

**Multi-step flow (v0.5).** Ask: *"write a test for login → add to cart → checkout."*

1. **`session_open({ url })`** opens a persistent page. The session survives across calls.
2. **`session_act({ session_id, actions })`** runs declared actions and returns what the page
   did: `observed.navigations` (redirect targets), `observed.requests` (method, path, status),
   console errors, dialogs, popups. These feed `waitForURL` and `waitForResponse` in the test.
3. **`session_extract({ session_id, diff_against: "previous" })`** returns only what changed
   since the last snapshot: added nodes (the toast, the dialog), removed nodes, changed state
   (`value`, `is_disabled`, `aria_invalid`, `described_by`). That is the assertion list for the step.
4. Repeat 2 and 3 per step, then **`session_close`**.

Every fact a test needs (locator, redirect, API path, state transition) comes from the page, not
from the agent's memory.

## MCP surface

| Kind | Name | Purpose |
| --- | --- | --- |
| Tool | `extract_semantic_dom` | Extract a URL into Semantic JSON (`url`, `wait_for` default `auto` = load then settled, `wait_selector`, `include_hidden`, `max_nodes`, `viewport`, `include_click_targets`). Read-only, never touches the page. |
| Tool | `extract_semantic_dom_after` | Same, but first runs a short **declared** action list (fill/click/press/select/goto/wait, max 20) in the main frame and snapshots the resulting state, plus an `observed` block of what the page did meanwhile. Refuses to extract if the actions navigated off the allowlist. |
| Tool | `session_open` | Open a persistent page for a multi-step flow (`url`, `wait_for`, `wait_selector`, `viewport`). Returns a `session_id`. Sessions are capped and expire when idle. |
| Tool | `session_act` | Run declared actions in an open session. Returns the resulting URL/title and `observed`: main-frame navigations, xhr/fetch requests (method, path, status), console errors, dialogs (dismissed), popups (closed). |
| Tool | `session_extract` | Snapshot the session's current state (`snapshot_id` included). With `diff_against` (a snapshot id or `"previous"`) returns a **diff**: added, removed, changed nodes and the behavior observed in between. |
| Tool | `session_close` | Release the session's browser context. |
| Tool | `session_list` | Diagnostic: open sessions with URL, expiry and counts. |
| Tool | `check_auth` | Diagnostic: navigates with the configured storageState and reports whether the session bounced to a login-looking page (expired auth shows up as an answer, not a mystery). |
| Tool | `list_frames` | Diagnostic frame tree with same-origin/reachability classification. |
| Prompt | `write_playwright_test` | Team-standard test-writing prompt (`scenario`, `extract_json`, `team_name?`, `framework_note?`). |
| Resource | `conventions://playwright` | The same team conventions as read-only text. |

Errors (navigation failure, denied host, missing selector, expired session) come back as
structured JSON in the tool result, so the agent can react instead of crashing. Every tool carries
MCP annotations (`readOnlyHint`, `openWorldHint: false`) so clients can auto-approve the read-only
ones.

## Configuration (environment variables)

| Variable | Meaning |
| --- | --- |
| `QA_MCP_ALLOWED_HOSTS` | **Required.** Comma-separated hostnames the server may navigate to. Navigation is denied by default. Supports `host`, `host:port`, and `*.domain` entries. |
| `QA_MCP_STORAGE_STATE` | Optional path to a Playwright `storageState` JSON for pre-authenticated staging sessions. **This file holds a live session — it is gitignored; never commit it.** |
| `QA_MCP_TEAM_NAME` | Optional team name used in the `write_playwright_test` prompt (default `QA`). |
| `QA_MCP_SESSION_TTL_MS` | Idle time before a session is closed automatically (default `600000`, 10 minutes). |
| `QA_MCP_MAX_SESSIONS` | Max concurrently open sessions (default `3`). |

## Security posture

- Tool inputs are untrusted (they arrive via an LLM): strict schemas (`additionalProperties: false`),
  http/https only, host allowlist enforced before any navigation.
- `extract_semantic_dom` only **reads** the DOM. It never clicks, submits, or mutates the page.
  The sanctioned exceptions are `extract_semantic_dom_after` and `session_act`, which execute only
  an explicit, bounded, schema-validated action list, never log fill values, and refuse to extract
  if the page leaves the allowlisted hosts (a session in that state is closed).
- Sessions add their own limits: an idle TTL, a cap on open sessions, one in-flight call per
  session, and a bounded snapshot history kept in memory only.
- Behavior capture is **observation only**. The server never issues requests of its own. Request
  and response bodies are never read, query strings are stripped from recorded URLs (they may
  carry tokens), console text is capped, dialogs are dismissed and popups closed at once.
- Sessions check the allowlist before any action, after every action, after a failed action and
  before every snapshot. A session found off the allowlist is closed on the spot.
- No network egress beyond navigating the browser to allowlisted URLs. No telemetry. Page contents
  are never logged (stderr carries only high-level events) and are not stored beyond the current
  call or session.

## Semantics worth knowing

- **Snapshot honesty:** the JSON is a single moment. A disabled submit button is reported
  `is_disabled: true` with a note. The conventions instruct the model to write the interactions
  that change state, not to assume it stays disabled. In a session, the diff shows the transition
  itself (`is_disabled: false → true`), so the test asserts a fact rather than an assumption.
- **Compact wire format (schema 1.3):** results are compact JSON and a node field that carries no
  information is omitted: `null` fields, `frame_path: []`, `in_shadow: false`, `kind: "element"`,
  empty `fallback_locators`, and `text_content` equal to `accessible_name`. An absent property is
  null (not applicable, never false); absent structure means the default (main document, light
  DOM, nothing worth listing). `is_visible` is always present. Fallbacks appear only when the
  primary is ambiguous or brittle. Same facts, about a third of the tokens.
- **Assertable state (since schema 1.2):** every node reports `value` (never for password fields),
  `aria_expanded`, `aria_selected`, `aria_invalid`, `described_by` (the text of the elements
  `aria-describedby` points at, where validation messages live), `validation_message` (browser
  constraint validation) and, for `<select>`, `options`. Absent state is `null`, never `false`.
- **Observed behavior:** `observed.requests` lists xhr/fetch/document requests as method + path +
  status; static assets are counted in `dropped`, not listed. `observed.navigations` lists
  main-frame URL changes in order. Neither is ever guessed; if a redirect or API path is not in
  `observed`, the conventions tell the agent not to wait on it.
- **Diff identity:** nodes pair across snapshots by the most stable fact available: test-id, else
  id, else placeholder, else tag + role + accessible name, plus frame path and a document-order
  index for non-unique nodes. A hidden menu item that becomes visible is therefore a `changed`
  entry, with its primary locator switch (`getByText` → `getByRole`) listed as one of the changes.
  A renamed node with no stable attribute shows as removed + added; the diff says so in its notes.
- **Visibility is Playwright's:** `is_visible` predicts `toBeVisible()`, so it uses Playwright's
  rule (not `display:none`, `visibility` not hidden, width and height both > 0). Opacity and
  `aria-hidden` do not hide an element for Playwright and do not here either.
- **Secrets never leave the server:** a value typed into a password field, or a `fill` marked
  `secret: true`, is scrubbed from every string in every result (values, text, console, dialogs,
  errors) when it is 8+ characters. The set is process-wide and lasts until the server exits, so
  mark only real secrets: a redacted string blanks that text everywhere, and a locator whose text
  was redacted is flagged not unique. Password and credential-autocomplete fields never report a
  `value` at all.
- **Hidden nodes are included** and flagged `is_visible: false` (tests often assert hidden-ness);
  pass `include_hidden: false` to drop them (the count dropped is noted, never silent).
- **Open shadow DOM** is traversed and flagged `in_shadow` — locators pierce it natively, so no
  `>>>`/`::shadow` CSS is ever emitted. **Closed shadow roots** appear as `shadow_boundary`
  marker nodes (detected via pre-navigation `attachShadow` instrumentation; closed roots created
  by *declarative shadow DOM* parse before scripts run and cannot be detected).
- **Same-origin iframes** are extracted per-frame with `frame_path` set (chain `frameLocator()`
  in that order). **Cross-origin iframes** are recorded as opaque `cross_origin_frame` nodes with
  URL/name only — their DOM is never touched.
- **Notification & dialog surfaces** (`role="alert"`, `role="status"`, dialogs) are extracted like
  interactive nodes. When a toast library keeps the live region empty and renders the message in a
  sibling (a common pattern across UI libraries), the message text is pulled from the enclosing
  container and flagged. For UI that renders late after an interaction, `wait_selector_after` on
  `extract_semantic_dom_after` waits deterministically instead of guessing `settle_ms`. Since those ARIA roles take names from the author (not contents), their role
  locator is `getByRole('alert')` — or with the `aria-label` name when one exists. For UI that only
  appears **after** an interaction (login-success toast), use `extract_semantic_dom_after`.
- **JS-click cards** (product tiles with no anchor/role/test-id) are invisible to the factual
  rules by design — pass `include_click_targets: true` to include cursor-pointer boundary
  elements with content, flagged as heuristic and located by their heading text.
- **Links carry `href`** (schema 1.1) so agents can discover which page to extract next without
  scraping. **Framework-generated ids** (`rc_select_*`, React `useId`, Radix, MUI...) are detected
  and demoted to last-resort with a note — they change between builds and must never be primary.
- **`viewport: "mobile"`** (375×812, touch) snapshots responsive states; visibility flags reflect
  the active media queries.
- **Truncation is loud:** `max_nodes` / depth caps set `truncated: true` plus a note. Non-unique
  locators carry `is_unique: false` and `disambiguation` guidance.

## Development

```bash
git clone https://github.com/helmif/semantic-dom-mcp.git && cd semantic-dom-mcp
npm install
npx playwright install chromium
npm run dev        # run the server over stdio via tsx
npm run typecheck  # tsc --noEmit (strict)
npm test           # Vitest suites against real fixture pages in headless Chromium
npm run build      # compile to dist/ (clients can then use "command": "node", "args": ["<path>/dist/index.js"])
```

Repo layout: `src/index.ts` (bootstrap) · `src/server.ts` (MCP surface) · `src/browser.ts`
(Playwright layer + single-shot orchestration) · `src/session.ts` (persistent sessions) ·
`src/observe.ts` (behavior capture) · `src/diff.ts` (snapshot diff) · `src/extractor/` (in-page
engine + locator resolution) · `src/types.ts` (frozen contract, schema 1.3) · `src/compact.ts` (wire rules) · `src/conventions.ts`
(single source of team conventions).
