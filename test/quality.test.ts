import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkAuth, closeBrowser, extractSemanticDom, type ExtractInput } from "../src/browser.js";
import {
  assertValidExtract,
  htmlPage,
  nodeByTestId,
  startFixtureServer,
  type FixtureServer,
} from "./helpers.js";

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

describe("locator quality (v0.3)", () => {
  it("demotes framework-generated ids and flags them", async () => {
    fx.route(
      "/gen-ids",
      htmlPage(`
        <label for="rc_select_7">Kota</label><input id="rc_select_7" type="search">
        <button id=":r3:">Radix-ish</button>
        <input id="user-email" aria-label="Email">`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/gen-ids`)));

    // (the <label> element is its own extracted node — target the input)
    const city = extract.interactive_nodes.find((n) => n.tag === "input" && n.accessible_name === "Kota")!;
    expect(city.primary_locator.strategy).not.toBe("id"); // rc_select_7 must not win
    expect(city.primary_locator.playwright).toBe("getByRole('searchbox', { name: 'Kota' })");
    expect(city.context_note).toMatch(/framework-generated/);

    const radix = extract.interactive_nodes.find((n) => n.accessible_name === "Radix-ish")!;
    expect(radix.primary_locator.strategy).toBe("role");
    expect(radix.context_note).toMatch(/framework-generated/);

    // A human-authored id is still a legitimate fallback strategy.
    const email = extract.interactive_nodes.find((n) => n.tag === "input" && n.accessible_name === "Email")!;
    expect(
      [email.primary_locator, ...email.fallback_locators].some(
        (l) => l.strategy === "id" && l.playwright === "locator('#user-email')",
      ),
    ).toBe(true);
    expect(email.context_note).toBeUndefined();
  });

  it("omits brittle fallbacks when a unique semantic locator exists, caps at 4", async () => {
    fx.route(
      "/slim",
      htmlPage(`
        <label for="f1">Nama Lengkap</label>
        <input id="f1" data-testid="input-name" placeholder="Nama kamu">
        <div><button class="save">Simpan</button></div>
        <div><button class="save">Simpan</button></div>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/slim`)));

    const name = nodeByTestId(extract, "input-name");
    expect(name.fallback_locators.length).toBeLessThanOrEqual(4);
    // structural css dropped — a unique test-id primary makes it dead weight
    expect(name.fallback_locators.every((l) => !l.playwright.includes("nth-child"))).toBe(true);

    // ...but ambiguous nodes KEEP the structural css fallback (it is the only
    // unique option and feeds .nth correlation).
    const saves = extract.interactive_nodes.filter((n) => n.tag === "button" && n.accessible_name === "Simpan");
    expect(saves).toHaveLength(2);
    for (const save of saves) {
      expect(save.primary_locator.is_unique).toBe(false);
      expect(save.fallback_locators.some((l) => l.strategy === "css" && l.is_unique)).toBe(true);
    }
  });

  it("captures absolute href on links (schema 1.1) and stays null elsewhere", async () => {
    fx.route(
      "/hrefs",
      htmlPage(`
        <a href="/products/sepatu-123">Sepatu Keren</a>
        <a href="javascript:void(0)">JS pseudo-link</a>
        <button>No href here</button>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/hrefs`)));

    const product = extract.interactive_nodes.find((n) => n.accessible_name === "Sepatu Keren")!;
    expect(product.properties.href).toBe(`${fx.base}/products/sepatu-123`);

    const pseudo = extract.interactive_nodes.find((n) => n.accessible_name === "JS pseudo-link")!;
    expect(pseudo.properties.href).toBeNull(); // javascript: never surfaced

    const btn = extract.interactive_nodes.find((n) => n.tag === "button")!;
    expect(btn.properties.href).toBeNull();
  });

  it("adds a hint note when the extraction comes back empty", async () => {
    fx.route("/empty", htmlPage(`<p>Just prose, nothing interactive.</p>`));
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/empty`)));
    expect(extract.interactive_nodes).toHaveLength(0);
    expect(extract.page_metadata.notes.join(" ")).toMatch(/0 nodes extracted/);
  });
});

describe("viewport preset (v0.3)", () => {
  it("mobile viewport changes visibility of responsive elements", async () => {
    fx.route(
      "/responsive",
      htmlPage(`
        <style>@media (max-width: 500px) { .desktop-only { display: none; } }</style>
        <button class="desktop-only" data-testid="desktop-nav">Desktop Nav</button>
        <button data-testid="always">Always</button>`),
    );
    const desktop = assertValidExtract(await extractSemanticDom(input(`${fx.base}/responsive`)));
    expect(nodeByTestId(desktop, "desktop-nav").properties.is_visible).toBe(true);

    const mobile = assertValidExtract(
      await extractSemanticDom(input(`${fx.base}/responsive`, { viewport: "mobile" })),
    );
    expect(nodeByTestId(mobile, "desktop-nav").properties.is_visible).toBe(false);
    expect(nodeByTestId(mobile, "always").properties.is_visible).toBe(true);
  });
});

describe("check_auth (v0.3)", () => {
  it("reports a login-looking landing as logged out", async () => {
    fx.route("/login", htmlPage(`<form id="login"><input aria-label="Email"></form>`, "Login"));
    const report = await checkAuth(`${fx.base}/login`, "load");
    expect(report).toMatchObject({ storage_state: "not_set", looks_logged_out: true });
  });

  it("reports a normal page as logged in", async () => {
    fx.route("/dashboard", htmlPage(`<h1>Dash</h1>`, "Dash"));
    const report = await checkAuth(`${fx.base}/dashboard`, "load");
    expect(report.looks_logged_out).toBe(false);
    expect(report.redirected).toBe(false);
  });
});
