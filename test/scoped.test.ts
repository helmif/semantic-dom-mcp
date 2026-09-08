import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, extractAfterActions, extractSemanticDom, type ExtractInput } from "../src/browser.js";
import { assertValidExtract, htmlPage, nodeByTestId, startFixtureServer, type FixtureServer } from "./helpers.js";

/* Scoped locators (schema 1.4): nameless or repeated controls located inside
 * their row, list item or test-id container, the way a QA engineer writes
 * them by hand. Patterns copied from a real seller dashboard. */

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

describe("scoped locators", () => {
  it("locates a nameless custom radio and a repeated quantity field by their table row", async () => {
    const row = (name: string, price: string) =>
      `<tr><td><div role="radio" aria-checked="false" tabindex="0"></div></td><td>${name}</td><td>${price}</td>
       <td><input type="number" placeholder="0" value="0"></td></tr>`;
    fx.route(
      "/variants",
      htmlPage(`<table><thead><tr><th></th><th>Nama Varian</th><th>Harga</th><th>Kuantitas</th></tr></thead>
        <tbody>${row("Charizard", "Rp35.000")}${row("Dragonite", "Rp35.000")}${row("Gardevoir", "Rp40.000")}</tbody></table>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/variants`)));

    const radios = extract.interactive_nodes.filter((n) => n.role === "radio");
    expect(radios).toHaveLength(3);
    // A nameless radio gets a bare role locator inside its row, verified unique.
    expect(radios[0]!.primary_locator).toMatchObject({
      strategy: "role",
      playwright: "getByRole('row', { name: 'Charizard' }).getByRole('radio')",
      is_unique: true,
      within: { kind: "row", value: "Charizard" },
    });
    expect(radios[1]!.primary_locator.playwright).toBe("getByRole('row', { name: 'Dragonite' }).getByRole('radio')");

    // The repeated placeholder field: unscoped is ambiguous (3), scoped is unique.
    const qty = extract.interactive_nodes.filter((n) => n.role === "spinbutton");
    expect(qty).toHaveLength(3);
    expect(qty[2]!.primary_locator).toMatchObject({
      playwright: "getByRole('row', { name: 'Gardevoir' }).getByPlaceholder('0')",
      is_unique: true,
      within: { kind: "row", value: "Gardevoir" },
    });
    expect(qty[2]!.fallback_locators.some((l) => l.playwright === "getByPlaceholder('0')" && !l.is_unique)).toBe(true);
  });

  it("scopes to a list item by its text and to a test-id container, and drops textless <label> chrome", async () => {
    fx.route(
      "/buyers",
      htmlPage(`
        <ul>
          <li><h4>Dhanna</h4><p>Jl. Mawar 1</p><button>Pilih Pembeli Ini</button></li>
          <li><h4>Puthera</h4><p>Jl. Melati 2</p><button>Pilih Pembeli Ini</button></li>
        </ul>
        <div data-testid="customer-checkbox-flex"><label><span><input type="checkbox"></span></label><span>Dhano</span></div>
        <div data-testid="other-checkbox-flex"><label><span><input type="checkbox"></span></label><span>Dhani</span></div>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/buyers`)));

    const pick = extract.interactive_nodes.filter((n) => n.accessible_name === "Pilih Pembeli Ini");
    expect(pick).toHaveLength(2);
    expect(pick[1]!.primary_locator).toMatchObject({
      playwright: "getByRole('listitem').filter({ hasText: 'Puthera' }).getByRole('button', { name: 'Pilih Pembeli Ini' })",
      is_unique: true,
      within: { kind: "listitem", value: "Puthera" },
    });

    const boxes = extract.interactive_nodes.filter((n) => n.role === "checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.primary_locator).toMatchObject({
      playwright: "getByTestId('customer-checkbox-flex').getByRole('checkbox')",
      is_unique: true,
      within: { kind: "test-id", value: "customer-checkbox-flex" },
    });
    // The textless <label> wrappers are chrome, not controls.
    expect(extract.interactive_nodes.filter((n) => n.tag === "label")).toEqual([]);
    expect(extract.interactive_nodes.filter((n) => n.primary_locator.strategy === "css")).toEqual([]);
  });

  it("names an icon-only button from its svg title and accepts `within` in declared actions", async () => {
    fx.route(
      "/icons",
      htmlPage(`
        <ul>
          <li><span>Charizard</span><button onclick="this.nextElementSibling.textContent='1'"><svg><title>Tambah</title><path d="M0 0h1"/></svg></button><output role="status" data-testid="q1">0</output></li>
          <li><span>Dragonite</span><button onclick="this.nextElementSibling.textContent='1'"><svg><title>Tambah</title><path d="M0 0h1"/></svg></button><output role="status" data-testid="q2">0</output></li>
        </ul>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/icons`)));
    const plus = extract.interactive_nodes.filter((n) => n.accessible_name === "Tambah");
    expect(plus).toHaveLength(2);
    expect(plus[1]!.primary_locator.playwright).toBe("getByRole('listitem').filter({ hasText: 'Dragonite' }).getByRole('button', { name: 'Tambah' })");

    // Act through the scoped locator, exactly as returned.
    const after = assertValidExtract(
      await extractAfterActions({
        ...input(`${fx.base}/icons`),
        actions: [{ type: "click", locator: { strategy: "role", role: "button", value: "Tambah", within: { kind: "listitem", value: "Dragonite" } } }],
        settle_ms: 100,
      }),
    );
    expect(nodeByTestId(after, "q2").properties.text_content).toBe("1");
    expect(nodeByTestId(after, "q1").properties.text_content).toBe("0");
  });
});
