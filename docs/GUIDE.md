# Team guide: setup, connecting your AI agent, and daily workflow

This is the onboarding path for a QA engineer. The [README](../README.md) says
what the tool is; this says how to get it working with *your* agent.

## 1. One-time setup

```bash
git clone git@github.com:helmif/semantic-dom-mcp.git
cd semantic-dom-mcp
npm install
npx playwright install chromium
npm run build
```

Sanity check: `npm test` should end with all tests passing (it launches a real
headless Chromium against local fixture pages).

## 2. Decide your environment values

| Variable | What to set |
| --- | --- |
| `QA_MCP_ALLOWED_HOSTS` | The staging hostnames you test, comma-separated (e.g. `staging.yourapp.internal,staging.admin.internal`). **Required** — with it unset, every navigation is refused. Supports `host`, `host:port`, `*.domain`. |
| `QA_MCP_STORAGE_STATE` | Only if staging needs login: path to a Playwright storageState JSON (see §5). |
| `QA_MCP_TEAM_NAME` | Optional; appears in the generated prompt ("You are a Senior QA Automation Engineer on the … team"). |

## 3. Connect your agent

All clients speak the same stdio config; only the file location differs.
`<ABS>` below = the absolute path to your clone (e.g. `D:/Ngoding/semantic-dom-mcp`).

**Claude Code (CLI / VS Code)** — from your test project's directory:

```bash
claude mcp add semantic-dom --scope project \
  --env QA_MCP_ALLOWED_HOSTS=staging.yourapp.internal \
  -- node <ABS>/dist/index.js
```

or commit a `.mcp.json` in the test repo so the whole team gets it:

```json
{
  "mcpServers": {
    "semantic-dom": {
      "command": "node",
      "args": ["<ABS>/dist/index.js"],
      "env": { "QA_MCP_ALLOWED_HOSTS": "staging.yourapp.internal" }
    }
  }
}
```

**Claude Desktop** — same `mcpServers` block in
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

**Cursor** — same block in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global).

**Windsurf** — same block in `~/.codeium/windsurf/mcp_config.json`.

**Verify:** ask the agent *"list your MCP tools"* — you should see
`extract_semantic_dom` and `list_frames`. Then:
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
locator verification finishes (their locators then report 0 matches — raise
`settle_ms` or ask the frontend for a longer-lived/toast test-id).

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
| `0 nodes` on a page that clearly has content | SPA rendered after the wait point. Use the default `wait_for: "networkidle"`, or `wait_selector` for a key element. (We hit exactly this on a production React SPA with `wait_for: "load"`.) |
| `navigation_failed` timeout with `networkidle` | Page never goes network-quiet (analytics/polling). Use `wait_for: "load"` + `wait_selector`. |
| `Executable doesn't exist` | Run `npx playwright install chromium` in the server's clone. |
| `storage_state_missing` | `QA_MCP_STORAGE_STATE` points at a file that isn't there — regenerate it (§5). |
| Extraction returns a login page instead of the requested page | Session expired. Run the `check_auth` tool to confirm (`looks_logged_out: true`), then regenerate the storageState (§5). |
| Locator in generated test not in the extraction | The agent ignored the rules — reject the PR; that is exactly what review is for. |
