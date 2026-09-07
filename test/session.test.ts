import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser } from "../src/browser.js";
import {
  actInSession,
  closeAllSessions,
  closeSession,
  extractInSession,
  listSessions,
  openSession,
  openSessionCount,
  type SessionExtractInput,
} from "../src/session.js";
import type { SemanticDiff, SemanticExtract } from "../src/types.js";
import { assertValidExtract, htmlPage, semanticDiffSchema, startFixtureServer, type FixtureServer } from "./helpers.js";

let fx: FixtureServer;

function extractInput(session_id: string, overrides: Partial<SessionExtractInput> = {}): SessionExtractInput {
  return { session_id, include_hidden: true, max_nodes: 5000, ...overrides };
}

async function open(path: string) {
  return openSession({ url: `${fx.base}${path}`, wait_for: "load" });
}

beforeAll(async () => {
  fx = await startFixtureServer();
  process.env.QA_MCP_ALLOWED_HOSTS = "127.0.0.1";
  delete process.env.QA_MCP_STORAGE_STATE;
  delete process.env.QA_MCP_SESSION_TTL_MS;
  delete process.env.QA_MCP_MAX_SESSIONS;

  // A three-step flow: login (POST /api/login, redirect) → dashboard → settings.
  fx.route(
    "/login",
    htmlPage(
      `
      <form onsubmit="event.preventDefault();
        fetch('/api/login?token=SECRET', { method: 'POST' })
          .then(() => { location.href = '/dashboard'; });">
        <label for="email">Email</label><input id="email" data-testid="email" type="email" required>
        <label for="pw">Kata sandi</label><input id="pw" data-testid="password" type="password" required>
        <button data-testid="submit" type="submit">Masuk</button>
      </form>`,
      "Login",
    ),
  );
  fx.route("/api/login", "ok");
  fx.route(
    "/dashboard",
    htmlPage(
      `<h1>Dashboard</h1>
       <a data-testid="settings" href="/settings">Pengaturan</a>
       <button data-testid="toast-btn" onclick="
         this.disabled = true;
         const t = document.createElement('div'); t.setAttribute('role','alert'); t.textContent = 'Tersimpan'; document.body.appendChild(t);
         const i = document.querySelector('[data-testid=note]'); i.setAttribute('aria-invalid','true'); i.setAttribute('aria-describedby','note-err');
         const e = document.createElement('span'); e.id = 'note-err'; e.textContent = 'Catatan wajib diisi'; document.body.appendChild(e);
       ">Simpan</button>
       <input data-testid="note" aria-label="Catatan">
       <select data-testid="lang" aria-label="Bahasa"><option value="id">Indonesia</option><option value="en">English</option></select>`,
      "Dashboard",
    ),
  );
  fx.route("/settings", htmlPage(`<h1>Settings</h1><button data-testid="save">Simpan</button>`, "Settings"));
});

afterEach(async () => {
  await closeAllSessions();
  delete process.env.QA_MCP_SESSION_TTL_MS;
  delete process.env.QA_MCP_MAX_SESSIONS;
});

afterAll(async () => {
  await closeAllSessions();
  await closeBrowser();
  await fx.close();
});

/* ------------------------------------------------------------------ */

describe("session flow: open → act → extract/diff → close", () => {
  it("walks a login flow, observing the request and redirect, and diffs the page change", async () => {
    const s = await open("/login");
    expect(s.session_id).toMatch(/^s_[0-9a-f]{12}$/);
    expect(s.title).toBe("Login");
    expect(s.open_sessions).toBe(1);

    const first = assertValidExtract((await extractInSession(extractInput(s.session_id))) as SemanticExtract);
    expect(first.snapshot_id).toBe(1);
    // Always present on session snapshots; empty here because nothing happened since open.
    expect(first.observed).toMatchObject({ navigations: [], requests: [], console_errors: [] });

    const act = await actInSession({
      session_id: s.session_id,
      actions: [
        { type: "fill", locator: { strategy: "test-id", value: "email" }, value: "qa@example.test" },
        { type: "fill", locator: { strategy: "test-id", value: "password" }, value: "hunter2" },
        { type: "click", locator: { strategy: "test-id", value: "submit" } },
      ],
      settle_ms: 200,
      wait_selector_after: "[data-testid=toast-btn]",
    });
    expect(act.url).toBe(`${fx.base}/dashboard`);
    expect(act.title).toBe("Dashboard");
    expect(act.actions_performed).toBe(3);

    // Behavior facts a test needs: the API call awaited and the redirect target.
    const login = act.observed.requests.find((r) => r.url.endsWith("/api/login"))!;
    expect(login).toMatchObject({ method: "POST", status: 200, resource_type: "fetch" });
    expect(login.url).not.toContain("SECRET"); // query strings are stripped
    expect(act.observed.navigations.map((n) => n.to)).toContain(`${fx.base}/dashboard`);

    const diff = semanticDiffSchema.parse(
      await extractInSession(extractInput(s.session_id, { diff_against: "previous" })),
    ) as SemanticDiff;
    expect(diff.from_snapshot).toBe(1);
    expect(diff.to_snapshot).toBe(2);
    expect(diff.page_metadata.url_before).toBe(`${fx.base}/login`);
    expect(diff.page_metadata.url_after).toBe(`${fx.base}/dashboard`);
    expect(diff.removed.some((r) => r.primary_locator.playwright.includes("Kata sandi"))).toBe(true);
    expect(diff.added.some((n) => n.primary_locator.playwright === "getByTestId('settings')")).toBe(true);
    // The diff carries what happened between the two snapshots.
    expect(diff.observed?.navigations.map((n) => n.to)).toContain(`${fx.base}/dashboard`);

    const closed = await closeSession(s.session_id);
    expect(closed).toMatchObject({ closed: true, was_open: true, actions_performed: 3, snapshots_taken: 2 });
    expect(openSessionCount()).toBe(0);
    // Closing again is a no-op, not an error (idempotent tool).
    expect(await closeSession(s.session_id)).toMatchObject({ closed: true, was_open: false });
  });

  it("diffs same-page state changes: added toast, disabled button, invalid field, select value", async () => {
    const s = await open("/dashboard");
    await extractInSession(extractInput(s.session_id));
    await actInSession({
      session_id: s.session_id,
      actions: [
        { type: "select", locator: { strategy: "test-id", value: "lang" }, value: "en" },
        { type: "click", locator: { strategy: "test-id", value: "toast-btn" } },
      ],
      settle_ms: 100,
    });
    const diff = semanticDiffSchema.parse(
      await extractInSession(extractInput(s.session_id, { diff_against: 1 })),
    ) as SemanticDiff;

    expect(diff.summary.removed).toBe(0);
    expect(diff.added.map((n) => n.role)).toEqual(["alert"]);
    expect(diff.added[0]!.accessible_name).toBe("Tersimpan");

    const byTestId = (id: string) => diff.changed.find((c) => c.node.primary_locator.playwright === `getByTestId('${id}')`)!;
    expect(byTestId("toast-btn").changes["properties.is_disabled"]).toEqual({ from: false, to: true });
    expect(byTestId("note").changes["properties.aria_invalid"]).toEqual({ from: null, to: true });
    expect(byTestId("note").changes["properties.described_by"]).toEqual({ from: null, to: "Catatan wajib diisi" });
    expect(byTestId("lang").changes["properties.value"]).toEqual({ from: "id", to: "en" });
    // Untouched nodes are counted, not listed.
    expect(diff.summary.unchanged).toBeGreaterThan(0);
  });

  it("supports goto within the allowlist and reports the navigation", async () => {
    const s = await open("/dashboard");
    const act = await actInSession({
      session_id: s.session_id,
      actions: [{ type: "goto", url: `${fx.base}/settings` }],
      settle_ms: 0,
    });
    expect(act.title).toBe("Settings");
    expect(act.observed.navigations.at(-1)?.to).toBe(`${fx.base}/settings`);
    const extract = assertValidExtract((await extractInSession(extractInput(s.session_id))) as SemanticExtract);
    expect(extract.interactive_nodes.some((n) => n.primary_locator.playwright === "getByTestId('save')")).toBe(true);
  });

  it("captures console errors, dialogs (dismissed) and popups (closed)", async () => {
    fx.route(
      "/noisy",
      htmlPage(`
        <button data-testid="boom" onclick="console.error('boom happened'); alert('Hei!'); window.open('/settings');">Go</button>
        <a data-testid="ext" href="/settings">x</a>`),
    );
    const s = await open("/noisy");
    const act = await actInSession({
      session_id: s.session_id,
      actions: [{ type: "click", locator: { strategy: "test-id", value: "boom" } }],
      settle_ms: 800,
    });
    expect(act.observed.console_errors).toEqual([{ level: "error", text: "boom happened" }]);
    expect(act.observed.dialogs).toEqual([{ type: "alert", message: "Hei!", handled: "dismissed" }]);
    expect(act.observed.popups).toEqual([{ url: `${fx.base}/settings`, handled: "closed" }]);
    // The popup did not become the session page.
    expect(act.url).toBe(`${fx.base}/noisy`);
  });
});

/* ------------------------------------------------------------------ */

describe("session guardrails", () => {
  it("closes the session when actions navigate off the allowlist", async () => {
    // localhost is a different host than 127.0.0.1 and is NOT allowlisted.
    fx.route("/leave", htmlPage(`<a data-testid="out" href="${fx.altBase}/settings">Keluar</a>`));
    const s = await open("/leave");
    await expect(
      actInSession({
        session_id: s.session_id,
        actions: [{ type: "click", locator: { strategy: "test-id", value: "out" } }],
        settle_ms: 200,
      }),
    ).rejects.toMatchObject({ code: "navigated_off_allowlist" });
    expect(openSessionCount()).toBe(0);
    await expect(extractInSession(extractInput(s.session_id))).rejects.toMatchObject({ code: "session_not_found" });
  });

  it("refuses a goto action outside the allowlist without leaving the current page", async () => {
    const s = await open("/dashboard");
    await expect(
      actInSession({ session_id: s.session_id, actions: [{ type: "goto", url: `${fx.altBase}/settings` }], settle_ms: 0 }),
    ).rejects.toMatchObject({ code: "url_not_allowed" });
    // The session survives a refused action; the page never moved.
    const list = await listSessions();
    expect(list.open_sessions.map((o) => o.url)).toEqual([`${fx.base}/dashboard`]);
  });

  it("caps open sessions and reports the limit", async () => {
    process.env.QA_MCP_MAX_SESSIONS = "1";
    const s = await open("/dashboard");
    await expect(open("/settings")).rejects.toMatchObject({ code: "session_limit" });
    await closeSession(s.session_id);
    const again = await open("/settings");
    expect(again.open_sessions).toBe(1);
  });

  it("expires idle sessions after the TTL", async () => {
    process.env.QA_MCP_SESSION_TTL_MS = "150";
    const s = await open("/dashboard");
    await new Promise((r) => setTimeout(r, 300));
    await expect(extractInSession(extractInput(s.session_id))).rejects.toMatchObject({ code: "session_not_found" });
    expect((await listSessions()).open_sessions).toEqual([]);
  });

  it("refuses unknown snapshot ids without consuming a snapshot or the recording", async () => {
    const s = await open("/dashboard");
    await actInSession({ session_id: s.session_id, actions: [{ type: "goto", url: `${fx.base}/settings` }], settle_ms: 0 });
    // 'previous' with no prior snapshot is refused, not silently full.
    await expect(extractInSession(extractInput(s.session_id, { diff_against: "previous" }))).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
    await expect(extractInSession(extractInput(s.session_id, { diff_against: 42 }))).rejects.toMatchObject({
      code: "snapshot_not_found",
    });
    // Neither refusal took a snapshot, and the navigation recorded since open is still there.
    const first = assertValidExtract((await extractInSession(extractInput(s.session_id))) as SemanticExtract);
    expect(first.snapshot_id).toBe(1);
    expect(first.observed?.navigations.map((n) => n.to)).toEqual([`${fx.base}/settings`]);
    const diff = semanticDiffSchema.parse(await extractInSession(extractInput(s.session_id, { diff_against: "previous" })));
    expect(diff.from_snapshot).toBe(1);
    expect(diff.to_snapshot).toBe(2);
  });

  it("closes a session stranded off the allowlist by a failed action batch", async () => {
    fx.route("/leave2", htmlPage(`<a data-testid="out" href="${fx.altBase}/settings">Keluar</a>`));
    const s = await open("/leave2");
    // Action 1 navigates off the allowlist; action 2 fails on the foreign page.
    // The allowlist verdict outranks the action failure, and the session is gone.
    await expect(
      actInSession({
        session_id: s.session_id,
        actions: [
          { type: "click", locator: { strategy: "test-id", value: "out" } },
          { type: "wait", ms: 200 },
          { type: "click", locator: { strategy: "test-id", value: "nope" } },
        ],
        settle_ms: 0,
      }),
    ).rejects.toMatchObject({ code: "navigated_off_allowlist" });
    expect(openSessionCount()).toBe(0);
  });

  it("never acts on a page that drifted off the allowlist between calls", async () => {
    fx.route(
      "/drift",
      htmlPage(`<button data-testid="b">x</button><script>setTimeout(() => { location.href = '${fx.altBase}/settings'; }, 100);</script>`),
    );
    const s = await open("/drift");
    await new Promise((r) => setTimeout(r, 500));
    await expect(
      actInSession({ session_id: s.session_id, actions: [{ type: "wait", ms: 1 }], settle_ms: 0 }),
    ).rejects.toMatchObject({ code: "navigated_off_allowlist" });
    expect(openSessionCount()).toBe(0);
  });

  it("pairs a role-only node across a hidden→visible transition and reports its locator change", async () => {
    fx.route(
      "/menu-only",
      htmlPage(`
        <button data-testid="open" onclick="document.getElementById('m').style.display='block'">Menu</button>
        <div id="m" role="menu" style="display:none"><a role="menuitem" href="/profil">Profil</a></div>`),
    );
    const s = await open("/menu-only");
    await extractInSession(extractInput(s.session_id));
    await actInSession({ session_id: s.session_id, actions: [{ type: "click", locator: { strategy: "test-id", value: "open" } }], settle_ms: 50 });
    const diff = semanticDiffSchema.parse(await extractInSession(extractInput(s.session_id, { diff_against: "previous" })));
    // Hidden → getByRole cannot match, so the primary was getByText; visible → getByRole.
    // Same element, so it is CHANGED, not removed + added, and the locator switch is listed.
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    const item = diff.changed.find((c) => c.node.role === "menuitem")!;
    expect(item.changes["properties.is_visible"]).toEqual({ from: false, to: true });
    expect(item.changes["primary_locator.playwright"]).toEqual({
      from: "getByText('Profil')",
      to: "getByRole('menuitem', { name: 'Profil' })",
    });
  });

  it("scrubs typed secrets from every output string", async () => {
    fx.route(
      "/echo",
      htmlPage(`
        <input data-testid="pw" type="password" aria-label="Sandi" oninput="document.getElementById('o').textContent = 'typed: ' + this.value; console.error('pw=' + this.value)">
        <input data-testid="plain" aria-label="Catatan">
        <div id="o" role="status"></div>`),
    );
    const s = await open("/echo");
    const act = await actInSession({
      session_id: s.session_id,
      actions: [
        { type: "fill", locator: { strategy: "test-id", value: "pw" }, value: "super-rahasia-9" },
        { type: "fill", locator: { strategy: "test-id", value: "plain" }, value: "token-abc-123", secret: true },
      ],
      settle_ms: 50,
    });
    expect(JSON.stringify(act)).not.toContain("super-rahasia-9");
    expect(act.observed.console_errors[0]!.text).toBe("pw=[REDACTED]");
    const extract = assertValidExtract((await extractInSession(extractInput(s.session_id))) as SemanticExtract);
    const status = extract.interactive_nodes.find((n) => n.role === "status")!;
    expect(status.properties.text_content).toBe("typed: [REDACTED]");
    expect(extract.interactive_nodes.find((n) => n.accessible_name === "Catatan")!.properties.value).toBe("[REDACTED]");
    expect(JSON.stringify(extract)).not.toMatch(/super-rahasia-9|token-abc-123/);
  });

  it("keeps an action failure recoverable: the session stays open", async () => {
    const s = await open("/dashboard");
    await expect(
      actInSession({
        session_id: s.session_id,
        actions: [{ type: "click", locator: { strategy: "test-id", value: "does-not-exist" } }],
        settle_ms: 0,
      }),
    ).rejects.toMatchObject({ code: "action_failed" });
    const extract = assertValidExtract((await extractInSession(extractInput(s.session_id))) as SemanticExtract);
    expect(extract.page_metadata.url).toBe(`${fx.base}/dashboard`);
  });
});
