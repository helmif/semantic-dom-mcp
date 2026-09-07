// Drives the BUILT server (npm run build first) over stdio exactly as an MCP
// client would, walking the login flow of app.mjs and saving every tool
// result to ./out/ — the inputs login.spec.ts was written from.
// Usage: node benchmark/flow/app.mjs &  then  node benchmark/flow/drive.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE = process.env.BASE || "http://127.0.0.1:4177";
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = process.env.SERVER || join(HERE, "..", "..", "dist", "index.js");
mkdirSync("out", { recursive: true });

const transport = new StdioClientTransport({
  command: "node",
  args: [SERVER],
  env: { ...process.env, QA_MCP_ALLOWED_HOSTS: "127.0.0.1" },
  stderr: "pipe",
});
const client = new Client({ name: "e2e-driver", version: "0" });
await client.connect(transport);

const sizes = {};
async function call(name, args, saveAs) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  const ms = Date.now() - t0;
  if (saveAs) writeFileSync(`out/${saveAs}.json`, text);
  sizes[saveAs ?? name] = { chars: text.length, est_tokens: Math.round(text.length / 4), ms, isError: !!r.isError };
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

// 1. open on login page
const open = await call("session_open", { url: `${BASE}/login`, wait_for: "networkidle" }, "01-open");
const sid = open.session_id;

// 2. full snapshot of the login page
const login = await call("session_extract", { session_id: sid }, "02-login-full");

// 3. wrong password → error toast; diff against previous
const badAct = await call(
  "session_act",
  {
    session_id: sid,
    actions: [
      { type: "fill", locator: { strategy: "test-id", value: "login-email" }, value: "budi@toko.id" },
      { type: "fill", locator: { strategy: "test-id", value: "login-password" }, value: "salah" },
      { type: "click", locator: { strategy: "test-id", value: "login-submit" } },
    ],
    wait_selector_after: ".notice-message",
    settle_ms: 200,
  },
  "03-bad-login-act",
);
const badDiff = await call("session_extract", { session_id: sid, diff_against: "previous" }, "04-bad-login-diff");

// 4. correct password → redirect to dashboard, welcome modal renders late
const goodAct = await call(
  "session_act",
  {
    session_id: sid,
    actions: [
      { type: "fill", locator: { strategy: "test-id", value: "login-password" }, value: "rahasia123" },
      { type: "click", locator: { strategy: "test-id", value: "login-submit" } },
    ],
    wait_selector_after: "[data-testid=welcome-close]",
    settle_ms: 100,
  },
  "05-good-login-act",
);
const dashDiff = await call("session_extract", { session_id: sid, diff_against: "previous" }, "06-dashboard-diff");

// 5. close welcome modal, open account menu; diff
const menuAct = await call(
  "session_act",
  {
    session_id: sid,
    actions: [
      { type: "click", locator: { strategy: "test-id", value: "welcome-close" } },
      { type: "click", locator: { strategy: "test-id", value: "account-menu" } },
    ],
    settle_ms: 100,
  },
  "07-menu-act",
);
const menuDiff = await call("session_extract", { session_id: sid, diff_against: "previous" }, "08-menu-diff");

// 6. logout → back to login
const logoutAct = await call(
  "session_act",
  { session_id: sid, actions: [{ type: "click", locator: { strategy: "test-id", value: "logout" } }], wait_selector_after: "[data-testid=login-form]", settle_ms: 100 },
  "09-logout-act",
);
const closed = await call("session_close", { session_id: sid }, "10-close");
await client.close();

// Summary the way the A/B trace was reported.
const summary = {
  session: sid,
  steps: sizes,
  total_est_tokens: Object.values(sizes).reduce((a, s) => a + s.est_tokens, 0),
  facts: {
    bad_login_request: badAct.observed.requests.find((r) => r.url.endsWith("/api/auth/login")),
    bad_login_toast: badDiff.added.map((n) => ({ role: n.role, text: n.properties.text_content, locator: n.primary_locator.playwright })),
    good_login_request: goodAct.observed.requests.find((r) => r.url.endsWith("/api/auth/login")),
    redirect: goodAct.observed.navigations,
    dashboard_added: dashDiff.summary,
    welcome_dialog: dashDiff.added.filter((n) => n.role === "dialog").map((n) => n.primary_locator),
    menu_expanded_change: menuDiff.changed.find((c) => c.node.primary_locator.playwright === "getByTestId('account-menu')")?.changes,
    menu_items: menuDiff.changed.filter((c) => c.node.role === "menuitem").map((c) => ({ loc: c.node.primary_locator, changes: c.changes })),
    logout_request: logoutAct.observed.requests.find((r) => r.url.endsWith("/api/auth/logout")),
    logout_redirect: logoutAct.observed.navigations,
    closed,
  },
};
writeFileSync("out/summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
