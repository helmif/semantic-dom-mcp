import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeBrowser,
  extractAfterActions,
  extractSemanticDom,
  type ExtractAfterActionsInput,
  type ExtractInput,
} from "../src/browser.js";
import { assertValidExtract, htmlPage, startFixtureServer, type FixtureServer } from "./helpers.js";

let fx: FixtureServer;

function input(url: string, overrides: Partial<ExtractInput> = {}): ExtractInput {
  return { url, wait_for: "load", include_hidden: true, max_nodes: 5000, ...overrides };
}

function afterInput(
  url: string,
  actions: ExtractAfterActionsInput["actions"],
  overrides: Partial<ExtractAfterActionsInput> = {},
): ExtractAfterActionsInput {
  return { ...input(url), actions, settle_ms: 300, ...overrides };
}

beforeAll(async () => {
  fx = await startFixtureServer();
  process.env.QA_MCP_ALLOWED_HOSTS = "127.0.0.1";
  delete process.env.QA_MCP_STORAGE_STATE;
});

afterAll(async () => {
  await closeBrowser();
  await fx.close();
});

/* ------------------------------------------------------------------ */

describe("notification/dialog surfaces", () => {
  it("includes role=alert, role=status, and <dialog> nodes", async () => {
    fx.route(
      "/surfaces",
      htmlPage(`
        <div role="alert">Sesi kamu telah berakhir</div>
        <div role="status">3 item tersimpan</div>
        <dialog open aria-label="Konfirmasi"><p>Yakin?</p><button>OK</button></dialog>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/surfaces`)));

    // alert/status take names from author, not contents — bare getByRole is
    // the correct, verified-unique locator here.
    const alert = extract.interactive_nodes.find((n) => n.role === "alert")!;
    expect(alert.primary_locator).toMatchObject({ playwright: "getByRole('alert')", is_unique: true });
    expect(alert.accessible_name).toBe("Sesi kamu telah berakhir");
    expect(alert.properties.is_visible).toBe(true);

    const status = extract.interactive_nodes.find((n) => n.role === "status")!;
    expect(status.primary_locator.playwright).toBe("getByRole('status')");
    expect(status.accessible_name).toBe("3 item tersimpan");

    const dialog = extract.interactive_nodes.find((n) => n.role === "dialog")!;
    expect(dialog.tag).toBe("dialog");
    expect(dialog.accessible_name).toBe("Konfirmasi");
    expect(dialog.primary_locator.is_unique).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("extract_semantic_dom_after (declared actions)", () => {
  const toastPage = htmlPage(`
    <form id="login">
      <label for="u">Username</label>
      <input id="u" placeholder="Masukkan username">
      <button id="go" type="button">Do Login</button>
    </form>
    <script>
      document.getElementById("go").addEventListener("click", () => {
        const t = document.createElement("div");
        t.setAttribute("role", "alert");
        t.setAttribute("data-testid", "toast-success");
        t.textContent = "Login berhasil";
        document.body.appendChild(t);
      });
    </script>`);

  it("captures post-interaction UI that a plain snapshot cannot see", async () => {
    fx.route("/toast", toastPage);

    const before = assertValidExtract(await extractSemanticDom(input(`${fx.base}/toast`)));
    expect(before.interactive_nodes.some((n) => n.role === "alert")).toBe(false);

    const after = assertValidExtract(
      await extractAfterActions(
        afterInput(`${fx.base}/toast`, [
          { type: "fill", locator: { strategy: "placeholder", value: "Masukkan username" }, value: "helmi" },
          { type: "click", locator: { strategy: "role", role: "button", value: "Do Login" } },
        ]),
      ),
    );
    const toast = after.interactive_nodes.find((n) => n.role === "alert")!;
    expect(toast).toBeDefined();
    expect(toast.accessible_name).toBe("Login berhasil");
    expect(toast.primary_locator).toMatchObject({
      strategy: "test-id",
      playwright: "getByTestId('toast-success')",
      is_unique: true,
    });
    expect(after.page_metadata.notes.join(" ")).toMatch(/AFTER 2 declared action/);
  });

  it("refuses to extract when the actions navigate off the allowlist", async () => {
    // 127.0.0.1 is allowlisted; localhost is the same server but a different host.
    fx.route("/nav", htmlPage(`<a id="out" href="http://localhost:${fx.port}/other">Keluar</a>`));
    fx.route("/other", htmlPage(`<button>Elsewhere</button>`));
    await expect(
      extractAfterActions(
        afterInput(`${fx.base}/nav`, [{ type: "click", locator: { strategy: "id", value: "out" } }]),
      ),
    ).rejects.toMatchObject({ code: "navigated_off_allowlist" });
  });

  it("surfaces failing actions as structured errors without echoing fill values", async () => {
    fx.route("/plain-form", htmlPage(`<input placeholder="Nama">`));
    const err = await extractAfterActions(
      afterInput(`${fx.base}/plain-form`, [
        { type: "fill", locator: { strategy: "test-id", value: "does-not-exist" }, value: "SECRET-VALUE" },
      ]),
    ).catch((e) => e as Error & { code: string });
    expect(err).toMatchObject({ code: "action_failed" });
    expect(err.message).toContain("test-id='does-not-exist'");
    expect(err.message).not.toContain("SECRET-VALUE");
  }, 30_000);
});
