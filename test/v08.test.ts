import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, extractAfterActions, extractOutline, extractSemanticDom, verifyLocators, type ExtractInput } from "../src/browser.js";
import { actInSession, closeAllSessions, extractInSession, openSession, verifyInSession } from "../src/session.js";
import type { SemanticDiff, SemanticExtract, SemanticOutline } from "../src/types.js";
import { assertValidExtract, htmlPage, nodeByTestId, startFixtureServer, type FixtureServer } from "./helpers.js";

/* v0.8: outline first, then scoped and budgeted extraction; structured tables
 * and dialogs; expression-string action locators; verify_locators; one
 * round trip per step. Fixtures copy the admin product page the report
 * benchmarked: a filter form, a product table with repeated row actions, a
 * stock-detail modal with label/value fields. */

let fx: FixtureServer;

function input(url: string, overrides: Partial<ExtractInput> = {}): ExtractInput {
  return { url, wait_for: "load", include_hidden: true, max_nodes: 5000, ...overrides };
}

const PRODUCTS = htmlPage(
  `
  <header><nav aria-label="Utama"><a href="/products">Produk</a><a href="/orders">Pesanan</a></nav></header>
  <main>
    <form aria-label="Filter produk">
      <label>Cari <input name="q" placeholder="Nama produk"></label>
      <label>Stok <select name="stock"><option value="">Semua</option><option value="available">Tersedia</option></select></label>
      <button type="submit">Terapkan</button>
    </form>
    <table>
      <caption>Daftar produk</caption>
      <thead><tr><th>Produk</th><th>Status</th><th>Stok Global</th><th>Marketing Kit</th><th>Aksi</th></tr></thead>
      <tbody>
        <tr><td>Produk Varian Mix Minus</td><td>Aktif</td><td>-1</td><td>0</td><td><button>Lihat Detail</button><button>Edit</button></td></tr>
        <tr><td>Kaos Polos Hitam</td><td>Aktif</td><td>∞</td><td>3</td><td><button>Lihat Detail</button><button>Edit</button></td></tr>
        <tr><td>Sepatu Lari X</td><td>Nonaktif</td><td>12</td><td>1</td><td><button>Lihat Detail</button><button>Edit</button></td></tr>
      </tbody>
    </table>
    <nav aria-label="Pagination"><button>Sebelumnya</button><button>Berikutnya</button></nav>
  </main>
  <div role="dialog" aria-label="Detail Stok" style="display:none" id="stock">
    <dl><dt>Total Stok</dt><dd>-1</dd><dt>Dilacak</dt><dd>Ya</dd><dt>Lanjut Jual</dt><dd>Ya</dd></dl>
    <table><thead><tr><th>Varian</th><th>Stok</th></tr></thead><tbody><tr><td>Besar</td><td>∞</td></tr><tr><td>Kecil</td><td>-1</td></tr></tbody></table>
    <button>Tutup</button>
  </div>
  <script>
    document.querySelectorAll('tbody button').forEach((b) => { if (b.textContent === 'Lihat Detail') b.onclick = () => { document.getElementById('stock').style.display = 'block'; }; });
    document.querySelector('#stock button').onclick = () => { document.getElementById('stock').style.display = 'none'; };
  </script>`,
  "Products",
);

beforeAll(async () => {
  fx = await startFixtureServer();
  process.env.QA_MCP_ALLOWED_HOSTS = "127.0.0.1";
  delete process.env.QA_MCP_STORAGE_STATE;
  fx.route("/products", PRODUCTS);
});

afterEach(async () => {
  await closeAllSessions();
});

afterAll(async () => {
  await closeAllSessions();
  await closeBrowser();
  await fx.close();
});

describe("outline", () => {
  it("maps the page into regions with scope selectors, structured tables and dialog fields", async () => {
    const o = await extractOutline({ url: `${fx.base}/products`, wait_for: "load" });
    expect(o.kind).toBe("outline");
    expect(o.interactive_count).toBeGreaterThan(8);
    const kinds = o.regions.map((r) => `${r.kind}:${r.name ?? ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["navigation:Utama", "form:Filter produk", "table:Daftar produk", "navigation:Pagination", "dialog:Detail Stok"]));
    const table = o.regions.find((r) => r.kind === "table" && r.name === "Daftar produk")!;
    expect(table.row_count).toBe(3);
    expect(table.interactive_count).toBe(6);
    expect(table.selector).toBe("main table"); // 'table' alone is not unique (the dialog has one)
  });

  it("returns table rows with an identity that is unique among siblings, not the first repeated cell", async () => {
    const o = await extractOutline({ url: `${fx.base}/products`, wait_for: "load" });
    const t = o.tables.find((t) => t.name === "Daftar produk")!;
    expect(t.headers).toEqual(["Produk", "Status", "Stok Global", "Marketing Kit", "Aksi"]);
    expect(t.rows.map((r) => r.identity)).toEqual(["Produk Varian Mix Minus", "Kaos Polos Hitam", "Sepatu Lari X"]);
    expect(t.rows[0]!.cells).toMatchObject({ "Stok Global": "-1", "Marketing Kit": "0", Status: "Aktif" });
    expect(t.rows[1]!.cells["Stok Global"]).toBe("∞");
    // The hidden dialog is listed with its label/value fields and its own table.
    const d = o.dialogs.find((d) => d.name === "Detail Stok")!;
    expect(d.is_visible).toBe(false);
    expect(d.fields).toEqual({ "Total Stok": "-1", Dilacak: "Ya", "Lanjut Jual": "Ya" });
    expect(o.tables.some((t) => t.rows.some((r) => r.identity === "Kecil" && r.cells["Stok"] === "-1"))).toBe(true);
    // Cheap: the whole map is a few thousand characters.
    expect(JSON.stringify(o).length).toBeLessThan(4000);
  });
});

describe("scoped and budgeted extraction", () => {
  it("extracts one region by selector, filters by role, and scopes row actions by product name", async () => {
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/products`, { scope: "main table", roles: ["button"] })));
    expect(extract.interactive_nodes).toHaveLength(6);
    expect(extract.interactive_nodes.every((n) => n.role === "button")).toBe(true);
    const detail = extract.interactive_nodes.filter((n) => n.accessible_name === "Lihat Detail");
    // Row identity is the unique cell (product name), not the shared 'Aktif' status.
    expect(detail.map((n) => n.primary_locator.playwright)).toEqual([
      "getByRole('row', { name: 'Produk Varian Mix Minus' }).getByRole('button', { name: 'Lihat Detail' })",
      "getByRole('row', { name: 'Kaos Polos Hitam' }).getByRole('button', { name: 'Lihat Detail' })",
      "getByRole('row', { name: 'Sepatu Lari X' }).getByRole('button', { name: 'Lihat Detail' })",
    ]);
    expect(detail.every((n) => n.primary_locator.is_unique)).toBe(true);
  });

  it("honours visible_only, max_output_chars (loudly) and include_tables", async () => {
    const budget = assertValidExtract(await extractSemanticDom(input(`${fx.base}/products`, { visible_only: true, max_output_chars: 900, include_tables: true, scope: "main" })));
    expect(budget.omitted?.nodes).toBeGreaterThan(0);
    expect(budget.page_metadata.notes.join(" ")).toMatch(/omitted by max_output_chars/);
    expect(budget.interactive_nodes.every((n) => n.properties.is_visible)).toBe(true);
    expect(JSON.stringify(budget.interactive_nodes).length).toBeLessThan(1400);
    expect(budget.tables?.[0]?.rows[0]?.cells["Stok Global"]).toBe("-1");
    // An unknown scope is a loud empty result, not an error.
    const none = assertValidExtract(await extractSemanticDom(input(`${fx.base}/products`, { scope: "#does-not-exist" })));
    expect(none.interactive_nodes).toHaveLength(0);
    expect(none.page_metadata.notes.join(" ")).toMatch(/matched no element/);
  });

  it("names unlabeled framework controls by the text before them, as a hint only", async () => {
    fx.route(
      "/antd",
      htmlPage(`<div class="form-item"><div class="label">Kategori</div><div><input id="rc_select_0" role="combobox" aria-expanded="false"></div></div>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/antd`)));
    const combo = extract.interactive_nodes.find((n) => n.role === "combobox")!;
    expect(combo.accessible_name).toBeNull();
    expect(combo.context_note).toMatch(/nearest text before it is 'Kategori' \(hint only/);
  });
});

describe("expression locators, verify_locators, act-then-extract", () => {
  it("accepts a returned playwright expression as an action locator and rejects other syntax", async () => {
    const after = assertValidExtract(
      await extractAfterActions({
        ...input(`${fx.base}/products`),
        actions: [{ type: "click", locator: { playwright: "getByRole('row', { name: 'Sepatu Lari X' }).getByRole('button', { name: 'Lihat Detail' })" } as never }],
        settle_ms: 100,
        scope: "#stock",
      }),
    );
    expect(after.interactive_nodes.some((n) => n.accessible_name === "Tutup" && n.properties.is_visible)).toBe(true);

    const bad = (await extractAfterActions({
      ...input(`${fx.base}/products`),
      actions: [{ type: "click", locator: { playwright: "page.locator('x').click()" } as never }],
      settle_ms: 0,
    }).catch((e) => e)) as Error & { code: string };
    expect(bad.code).toBe("invalid_locator");
  });

  it("verifies a written spec's locators against the live page and summarises", async () => {
    const v = await verifyLocators({
      url: `${fx.base}/products`,
      wait_for: "load",
      locators: [
        "getByRole('row', { name: 'Kaos Polos Hitam' }).getByRole('button', { name: 'Edit' })",
        "getByRole('button', { name: 'Lihat Detail' })",
        "getByTestId('does-not-exist')",
        "page.locator('x')",
      ],
    });
    expect(v.results.map((r) => [r.matches, r.unique])).toEqual([[1, true], [3, false], [0, false], [null, false]]);
    expect(v.results[0]!.first).toMatchObject({ tag: "button", name: "Edit" });
    expect(v.results[3]!.error).toMatch(/Unsupported locator expression/);
    expect(v.summary).toEqual({ total: 4, unique: 1, ambiguous: 1, missing: 1, invalid: 1 });
  });

  it("does a whole step in one call: act, then diff scoped to the dialog, then verify in-session", async () => {
    const s = await openSession({ url: `${fx.base}/products`, wait_for: "load" });
    const first = (await extractInSession({ session_id: s.session_id, scope: "#stock" })) as SemanticExtract;
    expect(first.interactive_nodes.every((n) => !n.properties.is_visible)).toBe(true);

    const step = await actInSession({
      session_id: s.session_id,
      actions: [{ type: "click", locator: { playwright: "getByRole('row', { name: 'Produk Varian Mix Minus' }).getByRole('button', { name: 'Lihat Detail' })" } as never }],
      settle_ms: 100,
      then_extract: { scope: "#stock", include_tables: true },
    });
    const diff = step.extract as SemanticDiff;
    expect(diff.kind).toBe("diff");
    expect(diff.changed.find((c) => c.node.accessible_name === "Tutup")?.changes["properties.is_visible"]).toEqual({ from: false, to: true });

    const outline = (await extractInSession({ session_id: s.session_id, mode: "outline", scope: "#stock" })) as SemanticOutline;
    expect(outline.kind).toBe("outline");
    expect(outline.dialogs[0]?.fields["Total Stok"]).toBe("-1");
    expect(outline.tables[0]?.rows.map((r) => `${r.identity}=${r.cells["Stok"]}`)).toEqual(["Besar=∞", "Kecil=-1"]);

    const verdict = await verifyInSession(s.session_id, ["getByRole('dialog', { name: 'Detail Stok' })", "getByRole('button', { name: 'Tutup' })"]);
    expect(verdict.summary).toMatchObject({ unique: 2 });
    // Outlines do not consume snapshot ids: the next snapshot is #3 (after #1 and the act's diff #2).
    const next = (await extractInSession({ session_id: s.session_id, scope: "#stock" })) as SemanticExtract;
    expect(next.snapshot_id).toBe(3);
  });
});

describe("v0.8 on component-library markup", () => {
  it("scopes locators to the extraction root, borrows split-table headers, and keeps dialog fields honest", async () => {
    // Ant Design-style: a fixed-header table split in two <table>s, a
    // dialog with the same button text as the page, title/subtitle pairs.
    fx.route(
      "/antd-table",
      htmlPage(`
        <main>
          <button>Tambah ke Keranjang</button>
          <div class="ant-table">
            <div class="ant-table-header"><table><thead><tr><th>Nama Varian</th><th>Harga</th><th>Kuantitas</th></tr></thead></table></div>
            <div class="ant-table-body"><table><tbody>
              <tr><td>Charizard</td><td>Rp35.000</td><td><input type="number" placeholder="0"></td></tr>
              <tr><td>Dragonite</td><td>Rp35.000</td><td><input type="number" placeholder="0"></td></tr>
            </tbody></table></div>
          </div>
        </main>
        <div role="dialog">
          <div><h3>Card Gold</h3><span>4 varian tersedia</span></div>
          <div><span>Total Stok</span><span>-1</span></div>
          <div><button>Batal</button><button>Tambah ke Keranjang</button></div>
        </div>`),
    );
    const o = await extractOutline({ url: `${fx.base}/antd-table`, wait_for: "load" });
    expect(o.tables).toHaveLength(1); // the header-only half is folded into the body table
    expect(o.tables[0]!.headers).toEqual(["Nama Varian", "Harga", "Kuantitas"]);
    expect(o.tables[0]!.rows.map((r) => [r.identity, r.cells["Harga"]])).toEqual([["Charizard", "Rp35.000"], ["Dragonite", "Rp35.000"]]);
    expect(o.dialogs[0]!.fields).toEqual({ "Total Stok": "-1" }); // no title/subtitle or button pairs

    // Scoped to the dialog, the confirm button is unique INSIDE the scope and the
    // locator says so; the same text on the page outside does not matter.
    const dlg = assertValidExtract(await extractSemanticDom(input(`${fx.base}/antd-table`, { scope: "[role=dialog]" })));
    const confirm = dlg.interactive_nodes.find((n) => n.accessible_name === "Tambah ke Keranjang")!;
    expect(confirm.primary_locator).toMatchObject({
      playwright: "locator('[role=dialog]').getByRole('button', { name: 'Tambah ke Keranjang' })",
      is_unique: true,
      within: { kind: "css", value: "[role=dialog]" },
    });
    // And the expression round-trips into an action.
    const after = assertValidExtract(
      await extractAfterActions({
        ...input(`${fx.base}/antd-table`),
        actions: [{ type: "click", locator: { playwright: confirm.primary_locator.playwright } as never }],
        settle_ms: 0,
      }),
    );
    expect(after.observed?.console_errors).toEqual([]);
  });

  it("never puts a structural nth-child path on the wire", async () => {
    const { compactNode } = await import("../src/compact.js");
    const { emptyProperties } = await import("../src/types.js");
    const wire = compactNode({
      kind: "element", tag: "button", role: "button", in_shadow: false, frame_path: [], form_group: null, accessible_name: null,
      primary_locator: { strategy: "role", playwright: "getByRole('row', { name: 'Charizard' }).getByRole('button')", is_unique: false, disambiguation: "2 matches; use .nth(0)." },
      fallback_locators: [
        { strategy: "css", playwright: "locator('html > body:nth-child(2) > div:nth-child(14) > table:nth-child(1) > tr:nth-child(1) > td:nth-child(3) > button:nth-child(1)')", is_unique: true },
        { strategy: "css", playwright: "locator('[data-cy=\"plus\"]')", is_unique: true },
      ],
      properties: emptyProperties({ is_visible: true }),
    });
    expect(wire.fallback_locators).toEqual([{ strategy: "css", playwright: "locator('[data-cy=\"plus\"]')", is_unique: true }]);
  });
});
