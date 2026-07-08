# semantic-dom-mcp

Local MCP server (stdio, Node.js + TypeScript) that drives a real Chromium browser via Playwright
to extract a live page's DOM into compact, factual **Semantic JSON** with **Playwright-native
locators** — so AI-generated Playwright tests are consistent across the whole QA team, not just
accurate.

Same page → same extraction → same conventions → same test style, regardless of who runs it.

**Evidence:** [benchmark/RESULTS.md](benchmark/RESULTS.md) — on real pages the Semantic JSON is
**92–97% smaller** than the raw DOM an agent would otherwise consume, with every locator
uniqueness-verified by Playwright's engine and byte-identical output across runs.
**Docs:** [How it works (deep dive)](docs/HOW-IT-WORKS.md) · [Team guide (setup + connecting your agent)](docs/GUIDE.md) · [Benchmark methodology](benchmark/README.md) · [Roadmap](docs/ROADMAP.md)

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
see `extract_semantic_dom`. See [docs/GUIDE.md](docs/GUIDE.md) for per-client config
locations (Claude Code, Claude Desktop, Cursor, Windsurf), authenticated staging, and
troubleshooting. To run from a clone instead (contributors), see Development below.

## Workflow

1. Ask your agent: *"extract the checkout page and write a success-path test."*
2. The agent calls **`extract_semantic_dom({ url })`** — the server navigates a real Chromium
   page, runs the extractor inside the page, and returns Semantic JSON: every interactive node
   with a ready-to-paste Playwright locator, uniqueness verified by Playwright's own engine.
3. The agent uses the **`write_playwright_test`** prompt (scenario + the JSON), which injects the
   team conventions.
4. The result is a Playwright test in team style, grounded in real locators — never guessed ones.

## MCP surface

| Kind | Name | Purpose |
| --- | --- | --- |
| Tool | `extract_semantic_dom` | Extract a URL into Semantic JSON (`url`, `wait_for`, `wait_selector`, `include_hidden`, `max_nodes`). Read-only, never touches the page. |
| Tool | `extract_semantic_dom_after` | Same, but first runs a short **declared** action list (fill/click/press/wait, max 20) in the main frame and snapshots the resulting state — for toasts, validation errors, opened dialogs. Refuses to extract if the actions navigated off the allowlist. |
| Tool | `check_auth` | Diagnostic: navigates with the configured storageState and reports whether the session bounced to a login-looking page (expired auth shows up as an answer, not a mystery). |
| Tool | `list_frames` | Diagnostic frame tree with same-origin/reachability classification. |
| Prompt | `write_playwright_test` | Team-standard test-writing prompt (`scenario`, `extract_json`, `team_name?`, `framework_note?`). |
| Resource | `conventions://playwright` | The same team conventions as read-only text. |

Errors (navigation failure, denied host, missing selector) come back as structured JSON in the
tool result — the agent can react instead of crashing.

## Configuration (environment variables)

| Variable | Meaning |
| --- | --- |
| `QA_MCP_ALLOWED_HOSTS` | **Required.** Comma-separated hostnames the server may navigate to. Navigation is denied by default. Supports `host`, `host:port`, and `*.domain` entries. |
| `QA_MCP_STORAGE_STATE` | Optional path to a Playwright `storageState` JSON for pre-authenticated staging sessions. **This file holds a live session — it is gitignored; never commit it.** |
| `QA_MCP_TEAM_NAME` | Optional team name used in the `write_playwright_test` prompt (default `QA`). |

## Security posture

- Tool inputs are untrusted (they arrive via an LLM): strict schemas (`additionalProperties: false`),
  http/https only, host allowlist enforced before any navigation.
- `extract_semantic_dom` only **reads** the DOM — it never clicks, submits, or mutates the page.
  The one sanctioned exception is `extract_semantic_dom_after`, which executes only an explicit,
  bounded, schema-validated action list, never logs fill values, and aborts without extracting if
  the page leaves the allowlisted hosts.
- No network egress beyond navigating to the target URL. No telemetry. Page contents are never
  logged (stderr carries only high-level events) and are not stored beyond the current call.

## Semantics worth knowing

- **Snapshot honesty:** the JSON is a single moment. A disabled submit button is reported
  `is_disabled: true` with a note — the conventions instruct the model to write the interactions
  that change state, not to assume it stays disabled.
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
(Playwright layer + orchestration) · `src/extractor/` (in-page engine + locator resolution) ·
`src/types.ts` (frozen v1 contract) · `src/conventions.ts` (single source of team conventions).
