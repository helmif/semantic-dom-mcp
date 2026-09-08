# Team guide: setup, connecting your AI agent, and daily workflow

This is the onboarding path for a QA engineer. The [README](../README.md) says
what the tool is; this says how to get it working with *your* agent.

## 1. One-time setup

The server is published on npm — no clone or build needed. The only one-time
step is installing the Chromium build that matches the package's bundled
Playwright:

```bash
npx -y -p semantic-dom-mcp playwright install chromium
```

(Contributors who want to work on the server itself: clone the repo and see
the Development section of the README.)

## 2. Decide your environment values

| Variable | What to set |
| --- | --- |
| `QA_MCP_ALLOWED_HOSTS` | The staging hostnames you test, comma-separated (e.g. `staging.yourapp.internal,staging.admin.internal`). **Required** — with it unset, every navigation is refused. Supports `host`, `host:port`, `*.domain`. |
| `QA_MCP_STORAGE_STATE` | Only if staging needs login: path to a Playwright storageState JSON (see §5). |
| `QA_MCP_TEAM_NAME` | Optional; appears in the generated prompt ("You are a Senior QA Automation Engineer on the … team"). |
| `QA_MCP_SESSION_TTL_MS` | Optional; idle time before a flow session closes itself (default 10 minutes). |
| `QA_MCP_MAX_SESSIONS` | Optional; cap on open flow sessions (default 3). |

## 3. Connect your agent

All clients speak the same stdio config; only the file location differs.

**Claude Code (CLI / VS Code)** — from your test project's directory:

```bash
claude mcp add semantic-dom --scope project \
  --env QA_MCP_ALLOWED_HOSTS=staging.yourapp.internal \
  -- npx -y semantic-dom-mcp
```

or commit a `.mcp.json` in the test repo so the whole team gets it:

```json
{
  "mcpServers": {
    "semantic-dom": {
      "command": "npx",
      "args": ["-y", "semantic-dom-mcp"],
      "env": { "QA_MCP_ALLOWED_HOSTS": "staging.yourapp.internal" }
    }
  }
}
```

Pin a version (`"semantic-dom-mcp@0.6.1"`) if you want the whole team on
identical extractions until you choose to upgrade.

**Claude Desktop** — same `mcpServers` block in
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

**Cursor** — same block in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).

**Windsurf** — same block in `~/.codeium/windsurf/mcp_config.json`.

**Verify:** ask the agent *"list your MCP tools"*. You should see
`extract_semantic_dom`, `session_open` and `list_frames`. Then:
*"extract https://staging.yourapp.internal/login"*.

## 4. Daily workflow

1. **Extract first, always.** *"Extract the checkout page, then write a test
   for the success path."* The server's instructions push agents to do this
   unprompted, but saying it costs nothing.
2. The agent calls `extract_semantic_dom` → gets Semantic JSON → applies the
   `write_playwright_test` prompt (team conventions are injected server-side —
   you don't paste any rules).
3. **Review like a reviewer, not an author:** every locator in the PR must
   exist in the extraction; `.nth()` only where the extraction's
   `disambiguation` said so; states asserted (`toBeVisible`, `toBeDisabled`…).
4. Commit the extraction JSON next to the tests (an `extracts/` folder in the
   test repo) so every locator has provenance.

## 4b. Dynamic states: toasts, validation errors, dialogs

A plain extraction is a snapshot — it cannot see UI that only exists *after*
an interaction (a login-success toast, a validation message under an empty
field). For those, use **`extract_semantic_dom_after`**: it runs a short,
declared action list and snapshots the result. Typical agent flow:

1. `extract_semantic_dom` on the page → gives you the locators to act with.
2. `extract_semantic_dom_after` with e.g.
   `actions: [{ "type": "click", "locator": { "strategy": "role", "role": "button", "value": "Masuk" } }]`
   → returns the post-click state, toast included.
3. Write the test asserting both the action and the extracted post-state.

Notes: actions run in the main frame only; the page must stay on allowlisted
hosts; fill values are never logged; very short-lived toasts may expire before
locator verification finishes (their locators then report 0 matches; raise
`settle_ms` or ask the frontend for a longer-lived toast test-id).

The result also carries `observed`: the requests the page made while the
actions ran (method, path, status) and any navigation. Use them in the test
instead of guessing:

```ts
await Promise.all([
  page.waitForResponse((r) => r.url().includes('/api/login') && r.request().method() === 'POST'),
  page.getByRole('button', { name: 'Masuk' }).click(),
]);
await expect(page).toHaveURL(/\/dashboard$/);
```

## 4c. Multi-step flows: sessions and diffs

For a scenario that spans pages (login → cart → checkout), a fresh navigation
per snapshot replays everything. Use a session instead. Ask the agent:
*"open a session on the login page, log in, add the first product to the
cart, go to checkout, and write the test."* The agent's calls look like:

1. `session_open({ url: ".../login" })` → `{ session_id: "s_…" }`
2. `session_extract({ session_id })` → the login page (snapshot 1)
3. `session_act({ session_id, actions: [fill email, fill password, click Masuk] })`
   → `{ url: ".../dashboard", observed: { navigations, requests, … } }`
4. `session_extract({ session_id, diff_against: "previous" })` → only what
   changed: login fields removed, dashboard nodes added, plus the observed
   behavior in between (snapshot 2)
5. Repeat 3 and 4 per step. Every diff's `added` list is that step's
   assertion list; `changed` shows state transitions such as a button going
   `is_disabled: false → true` or a field gaining `aria_invalid: true` and a
   `described_by` message.
6. `session_close({ session_id })`

Action types: `fill`, `click`, `press`, `select` (choose a `<select>`
option), `goto` (navigate within the allowlist; absolute URL), `wait`. Max 20
per call. When a node's locator carries `within` (scoped to a row, list
item or test-id container), pass the same `within` in the action locator. Add `secret: true` to a `fill` whose value must never appear in any
output (password fields are detected automatically).

Rules the server enforces: a session that leaves the allowlisted hosts is
closed on the spot (checked before, during and after every action batch) and
nothing is extracted; an action failure on an allowlisted page (locator not
found) leaves the session open so the agent can retry with a fallback
locator; sessions close themselves after the idle TTL; at most
`QA_MCP_MAX_SESSIONS` are open at once; the last 5 snapshots are kept for
diffs. If the agent loses the session id (context compaction), `session_list`
recovers it.

Commit the diffs next to the tests as you would extractions. A diff is
~90% smaller than a full re-extraction, so a whole flow fits comfortably in
one agent context.

## 5. Authenticated staging (storageState)

Never commit credentials. Generate a session file once:

```bash
npx playwright codegen --save-storage=.auth/staging.json https://staging.yourapp.internal/login
# log in manually in the opened browser, then close it
```

Point `QA_MCP_STORAGE_STATE` at `.auth/staging.json` in your MCP config. The
file holds live cookies — it is gitignored here; gitignore it in your test
repo too, and regenerate when the session expires.

## 6. Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `url_not_allowed` | Host missing from `QA_MCP_ALLOWED_HOSTS` in the *client's* env block (each client passes its own env). |
| `0 nodes` on a page that clearly has content | SPA rendered after the wait point. Use the default `wait_for: "auto"` (load, then DOM quiet), or `wait_selector` for a key element. (We hit exactly this on a production React SPA with `wait_for: "load"`.) |
| `navigation_failed` timeout with `networkidle` | Page never goes network-quiet (analytics, Sentry, polling). Use the default `wait_for: "auto"`, or `load` + `wait_selector`. (Seen on a real dev environment: the default before v0.6.1 was `networkidle` and timed out after 30 s.) |
| `Executable doesn't exist` | The version-matched browser is missing — run `npx -y -p semantic-dom-mcp playwright install chromium`. |
| `storage_state_missing` | `QA_MCP_STORAGE_STATE` points at a file that isn't there — regenerate it (§5). |
| Extraction returns a login page instead of the requested page | Session expired. Run the `check_auth` tool to confirm (`looks_logged_out: true`), then regenerate the storageState (§5). |
| Locator in generated test not in the extraction | The agent ignored the rules. Reject the PR; that is exactly what review is for. |
| `session_busy` | Two calls hit one session at once (a client that parallelises tool calls). Calls on a session are serial; retry after the other call returns. |
| `action_failed` | The locator did not resolve or Playwright refused the action; the message ends with the reason from Playwright's call log (`intercepts pointer events`, `not visible`, `strict mode violation … resolved to N elements`). Take locators from the extraction and apply its `.nth()` guidance. |
| `wait_selector_timeout` / `wait_selector_after_timeout` | The selector never appeared (15 s). Verify it against an extraction, or extract without it to see what the page shows. |
| `page_unresponsive` | In-page extraction or reading the title did not complete (30 s / 5 s); the page's JavaScript is blocked. Retry after it settles or close the session. |
| `internal_error` | Anything unexpected; the message carries the first line. Please report it with the URL pattern. |
| `session_not_found` | The session expired (idle longer than `QA_MCP_SESSION_TTL_MS`) or was closed. Run `session_list`, then `session_open` again. |
| `session_limit` | Too many open sessions. Close one with `session_close` or raise `QA_MCP_MAX_SESSIONS`. |
| `navigated_off_allowlist` and the session is gone | The flow left the staging hosts (an external payment page, say). Add the host to the allowlist if it is yours, or stop the flow before that step. |
| `snapshot_not_found` on `diff_against` | No prior snapshot in this session (call `session_extract` once without `diff_against` first), or the id is older than the 5 kept. The refused call took no snapshot. |
| `url_not_allowed` on a `goto` with a path like `/checkout` | `goto` needs an absolute URL; build it from `observed.navigations` or the session URL. |
| `observed.requests` is empty after a click | The page used a resource type the filter drops (images, scripts) or no request fired. Only xhr/fetch/document/eventsource/websocket are listed; `dropped.requests` shows how many were filtered. |
