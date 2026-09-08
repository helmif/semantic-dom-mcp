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

    // A human-authored id gets no note; the unique role primary ends
    // verification before the id candidate is ever counted.
    const email = extract.interactive_nodes.find((n) => n.tag === "input" && n.accessible_name === "Email")!;
    expect(email.primary_locator).toMatchObject({ strategy: "role", is_unique: true });
    expect(email.fallback_locators).toEqual([]);
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
    // Verification stops at the first unique semantic candidate: a unique
    // test-id primary means no further counts and no fallbacks at all.
    expect(name.fallback_locators).toEqual([]);

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

describe("click-target heuristic (v0.4, opt-in)", () => {
  const cardsPage = htmlPage(`
    <div class="card" style="cursor:pointer"><h3>Sepatu Uji Coba</h3><p>Rp100.000 · Terjual 5 · deskripsi panjang produk</p></div>
    <div class="card" style="cursor:pointer"><h3>Tas Uji Coba</h3><p>Rp50.000</p></div>
    <div style="cursor:pointer"></div>
    <button>Beli</button>`);

  it("is OFF by default — JS-click cards stay excluded", async () => {
    fx.route("/cards", cardsPage);
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/cards`)));
    expect(extract.interactive_nodes.filter((n) => n.tag === "div")).toHaveLength(0);
    expect(extract.interactive_nodes.some((n) => n.tag === "button")).toBe(true);
  });

  it("includes pointer-boundary cards with heading-text locators when opted in", async () => {
    fx.route("/cards", cardsPage);
    const extract = assertValidExtract(
      await extractSemanticDom(input(`${fx.base}/cards`, { include_click_targets: true })),
    );
    const cards = extract.interactive_nodes.filter((n) => n.tag === "div");
    expect(cards).toHaveLength(2); // empty pointer div excluded, children not duplicated
    const shoe = cards.find((n) => n.primary_locator.playwright === "getByText('Sepatu Uji Coba')")!;
    expect(shoe.primary_locator.is_unique).toBe(true);
    expect(shoe.context_note).toMatch(/click-target heuristic/);
    // the button is included by the normal rules exactly once, not re-added
    expect(extract.interactive_nodes.filter((n) => n.tag === "button")).toHaveLength(1);
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

describe("real-listing patterns (v0.5.1, from app-dev run)", () => {
  it("names a click-target card by its heading and gives .nth() for cards repeated across sections", async () => {
    const card = (name: string) =>
      `<div style="cursor:pointer" class="card"><span>COD</span><h3>${name}</h3><p>Terjual 0 · Harga Rp10.000 Rekomendasi Rp15.000</p></div>`;
    fx.route(
      "/listing",
      htmlPage(`
        <section><h2>Terbaru</h2>${card("Sepatu Lari X")}${card("Tas Selempang Y")}</section>
        <section><h2>Rekomendasi</h2>${card("Sepatu Lari X")}</section>
        <section><h2>Promo</h2>${card("Sepatu Lari X")}</section>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/listing`, { include_click_targets: true })));
    const cards = extract.interactive_nodes.filter((n) => n.accessible_name === "Sepatu Lari X");
    expect(cards).toHaveLength(3);
    // The heading names the card; the full blob stays in text_content.
    expect(cards[0]!.properties.text_content).toMatch(/^COD.*Sepatu Lari X.*Rp10\.000/);
    // getByText resolves to the <h3> inside each card, not the card itself, so
    // the .nth() index must be found by containment — each card gets its own.
    expect(cards.map((c) => c.primary_locator.disambiguation)).toEqual([
      "3 matches in frame; use .nth(0).",
      "3 matches in frame; use .nth(1).",
      "3 matches in frame; use .nth(2).",
    ]);
    expect(extract.interactive_nodes.find((n) => n.accessible_name === "Tas Selempang Y")!.primary_locator.is_unique).toBe(true);
  });

  it("drops focus-trap sentinels but keeps focusable controls with a name or content", async () => {
    fx.route(
      "/sentinels",
      htmlPage(`
        <div role="dialog" aria-label="Masuk">
          <div tabindex="0" style="width:0;height:0;overflow:hidden"></div>
          <div tabindex="0" data-testid="custom-control">Pilih tanggal</div>
          <div tabindex="0" aria-label="Tutup"></div>
          <input aria-label="Email">
          <div tabindex="0" style="width:0;height:0;overflow:hidden"></div>
        </div>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/sentinels`)));
    const css = extract.interactive_nodes.filter((n) => n.primary_locator.strategy === "css");
    expect(css).toEqual([]); // no nameless structural-CSS nodes
    expect(extract.interactive_nodes.map((n) => n.accessible_name).sort()).toEqual(["Email", "Masuk", "Pilih tanggal", "Tutup"]);
  });
});

describe("audit fixes (v0.6.1)", () => {
  it("keeps diff identity independent of which locators were verified", async () => {
    // A unique role locator ends verification, so the id is never counted;
    // identity must still come from the id (in-page), not from the locators.
    fx.route("/ident-a", htmlPage(`<button id="submit-btn">Simpan</button>`));
    fx.route("/ident-b", htmlPage(`<button id="submit-btn" disabled>Menyimpan…</button>`));
    const a = assertValidExtract(await extractSemanticDom(input(`${fx.base}/ident-a`)));
    const b = assertValidExtract(await extractSemanticDom(input(`${fx.base}/ident-b`)));
    expect(a.interactive_nodes[0]!.fallback_locators).toEqual([]); // nothing beyond the unique role was counted
    expect(a.interactive_nodes[0]!.identity).toBe("id=submit-btn");
    const { diffExtracts } = await import("../src/diff.js");
    const d = diffExtracts({ ...a, snapshot_id: 1 }, { ...b, snapshot_id: 2 });
    expect(d.summary).toMatchObject({ added: 0, removed: 0, changed: 1 });
    expect(d.changed[0]!.changes["properties.is_disabled"]).toEqual({ from: false, to: true });
    expect(d.changed[0]!.changes["accessible_name"]).toEqual({ from: "Simpan", to: "Menyimpan…" });
  });

  it("keeps icon-only and ARIA-widget focusables, drops true sentinels", async () => {
    fx.route(
      "/focusables",
      htmlPage(`
        <div tabindex="0" title="Tutup" data-testid="icon-title"><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></div>
        <div tabindex="0" data-testid="icon-only"><svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg></div>
        <span role="slider" tabindex="0" aria-valuenow="30" data-testid="thumb"></span>
        <div tabindex="0" aria-labelledby="missing-id" style="width:0;height:0"></div>
        <div tabindex="0" style="width:0;height:0;overflow:hidden"></div>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/focusables`)));
    const ids = extract.interactive_nodes.map((n) => n.primary_locator.playwright);
    expect(ids).toEqual(expect.arrayContaining(["getByTestId('icon-title')", "getByTestId('icon-only')", "getByTestId('thumb')"]));
    expect(extract.interactive_nodes.filter((n) => n.primary_locator.strategy === "css")).toEqual([]);
    expect(extract.interactive_nodes).toHaveLength(3);
  });

  it("names elements with accname precedence and never emits a getByLabel that Playwright would not match", async () => {
    fx.route(
      "/labels",
      htmlPage(`
        <span id="t">Judul</span><input aria-labelledby="t" aria-label="Lain">
        <label>Nama <input aria-label="Nama lengkap" class="dup"></label>
        <label>Nama <input aria-label="Nama lengkap" class="dup"></label>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/labels`)));
    // aria-labelledby beats aria-label (accname spec, Playwright): the role
    // locator carries 'Judul' and is verified unique.
    const judul = extract.interactive_nodes.find((n) => n.tag === "input" && n.accessible_name === "Judul")!;
    expect(judul.primary_locator).toMatchObject({ playwright: "getByRole('textbox', { name: 'Judul' })", is_unique: true });
    // aria-label beats the wrapping <label> for both the name and getByLabel;
    // the ambiguous pair runs the whole chain and never emits getByLabel('Nama'),
    // nor a getByLabel('Nama lengkap') that would duplicate the role locator.
    const dups = extract.interactive_nodes.filter((n) => n.tag === "input" && n.accessible_name === "Nama lengkap");
    expect(dups).toHaveLength(2);
    for (const d of dups) {
      const all = [d.primary_locator, ...d.fallback_locators].map((l) => l.playwright);
      expect(all).not.toContain("getByLabel('Nama')");
      expect(all.some((p) => p.startsWith("getByLabel("))).toBe(false);
      expect(d.primary_locator.playwright).toBe("getByRole('textbox', { name: 'Nama lengkap' })");
    }
  });

  it("points .nth() at the card heading even when a same-text badge precedes it", async () => {
    // Identical cards, so no full-text locator is unique and the heading text
    // (4 matches: badge, heading, badge, heading) stays primary with .nth().
    const card = () => `<div style="cursor:pointer"><button>Promo</button><h3>Promo</h3><p>Barang Rp1.000</p></div>`;
    fx.route("/badges", htmlPage(card() + card()));
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/badges`, { include_click_targets: true })));
    const cards = extract.interactive_nodes.filter((n) => n.tag === "div" && n.accessible_name === "Promo");
    expect(cards.map((c) => c.primary_locator.disambiguation)).toEqual([
      "4 matches in frame; use .nth(1).",
      "4 matches in frame; use .nth(3).",
    ]);
  });
});
