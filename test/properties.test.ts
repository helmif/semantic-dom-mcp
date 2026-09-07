import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, extractAfterActions, extractSemanticDom, type ExtractInput } from "../src/browser.js";
import { assertValidExtract, htmlPage, nodeByTestId, startFixtureServer, type FixtureServer } from "./helpers.js";

let fx: FixtureServer;

function input(url: string, overrides: Partial<ExtractInput> = {}): ExtractInput {
  return { url, wait_for: "load", include_hidden: true, max_nodes: 5000, ...overrides };
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

describe("schema 1.2 assertable properties", () => {
  it("reports value, aria state, described_by text, validation message and select options", async () => {
    fx.route(
      "/props",
      htmlPage(`
        <form>
          <input data-testid="name" value="Budi" aria-invalid="true" aria-describedby="name-hint name-err">
          <span id="name-hint">Nama lengkap</span><span id="name-err">Terlalu pendek</span>
          <input data-testid="pw" type="password" value="rahasia-123">
          <input data-testid="pw-shown" type="text" autocomplete="current-password" value="rahasia-123">
          <input data-testid="otp" type="text" autocomplete="one-time-code" value="123456">
          <input data-testid="inv-empty" aria-invalid="" value="x">
          <input data-testid="inv-grammar" aria-invalid="grammar" value="x">
          <input data-testid="req" required>
          <select data-testid="city">
            <option value="jkt">Jakarta</option>
            <option value="sby" selected>Surabaya</option>
          </select>
          <button data-testid="menu" aria-expanded="false" aria-haspopup="menu">Menu</button>
          <div role="tablist"><button data-testid="tab" role="tab" aria-selected="true">Profil</button></div>
        </form>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/props`)));

    const name = nodeByTestId(extract, "name");
    expect(name.properties.value).toBe("Budi");
    expect(name.properties.aria_invalid).toBe(true);
    expect(name.properties.described_by).toBe("Nama lengkap Terlalu pendek");

    // Credential values are never surfaced: password type, and the
    // autocomplete tokens that survive a "show password" toggle.
    expect(nodeByTestId(extract, "pw").properties.value).toBeNull();
    expect(nodeByTestId(extract, "pw-shown").properties.value).toBeNull();
    expect(nodeByTestId(extract, "otp").properties.value).toBeNull();
    // aria-invalid: empty/unknown token is "not set", grammar/spelling are invalid.
    expect(nodeByTestId(extract, "inv-empty").properties.aria_invalid).toBeNull();
    expect(nodeByTestId(extract, "inv-grammar").properties.aria_invalid).toBe(true);

    const req = nodeByTestId(extract, "req");
    expect(req.properties.is_required).toBe(true);
    expect(req.properties.validation_message).toBeTruthy();
    expect(req.properties.value).toBe("");

    const city = nodeByTestId(extract, "city");
    expect(city.properties.value).toBe("sby");
    expect(city.properties.options).toEqual([
      { value: "jkt", label: "Jakarta", selected: false },
      { value: "sby", label: "Surabaya", selected: true },
    ]);

    expect(nodeByTestId(extract, "menu").properties.aria_expanded).toBe(false);
    expect(nodeByTestId(extract, "tab").properties.aria_selected).toBe(true);
    // Absent ARIA state stays null, never false.
    expect(name.properties.aria_expanded).toBeNull();
    expect(name.properties.options).toBeNull();
  });

  it("reflects post-action values through the after-tool and reports observed behavior", async () => {
    fx.route(
      "/after-props",
      htmlPage(`
        <input data-testid="q" aria-label="Cari">
        <select data-testid="sort" aria-label="Urutkan"><option value="new">Terbaru</option><option value="cheap">Termurah</option></select>
        <button data-testid="go" onclick="fetch('/api/search?q=' + document.querySelector('[data-testid=q]').value).then(() => { document.getElementById('out').textContent = 'done'; })">Cari</button>
        <div id="out" role="status"></div>`),
    );
    fx.route("/api/search", "ok");
    const extract = assertValidExtract(
      await extractAfterActions({
        ...input(`${fx.base}/after-props`),
        actions: [
          { type: "fill", locator: { strategy: "test-id", value: "q" }, value: "sepatu" },
          { type: "select", locator: { strategy: "test-id", value: "sort" }, value: "cheap" },
          { type: "click", locator: { strategy: "test-id", value: "go" } },
        ],
        settle_ms: 300,
      }),
    );
    expect(nodeByTestId(extract, "q").properties.value).toBe("sepatu");
    expect(nodeByTestId(extract, "sort").properties.value).toBe("cheap");

    const observed = extract.observed!;
    const search = observed.requests.find((r) => r.url.endsWith("/api/search"))!;
    expect(search.method).toBe("GET");
    expect(search.status).toBe(200);
    expect(search.url).not.toContain("?"); // query string stripped
    expect(observed.navigations).toEqual([]);
  });
});
