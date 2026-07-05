import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeBrowser, extractSemanticDom, listFrames, type ExtractInput } from "../src/browser.js";
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
  process.env.QA_MCP_ALLOWED_HOSTS = "127.0.0.1,localhost";
  delete process.env.QA_MCP_STORAGE_STATE;
});

afterAll(async () => {
  await closeBrowser();
  await fx.close();
});

/* ------------------------------------------------------------------ */

describe("form grouping", () => {
  it("groups fields and submit with their enclosing form; section landmark as fallback", async () => {
    fx.route(
      "/form",
      htmlPage(`
        <form id="checkout">
          <label for="em">Email address</label>
          <input id="em" type="email" required placeholder="Enter your email">
          <fieldset><input type="text" name="addr" data-testid="addr-line"></fieldset>
          <button type="submit" disabled>Pay Now</button>
        </form>
        <form>
          <input type="search" aria-label="Search products">
        </form>
        <section id="prefs">
          <div role="button" tabindex="0" data-testid="pref-toggle">Toggle prefs</div>
        </section>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/form`)));

    const email = extract.interactive_nodes.find((n) => n.properties.type === "email")!;
    expect(email.form_group).toBe("form#checkout");
    expect(email.accessible_name).toBe("Email address");
    expect(email.properties.is_required).toBe(true);
    expect(email.primary_locator.is_unique).toBe(true);

    const addr = nodeByTestId(extract, "addr-line");
    expect(addr.form_group).toBe("form#checkout"); // nested fieldset still resolves to the form

    const pay = extract.interactive_nodes.find((n) => n.accessible_name === "Pay Now")!;
    expect(pay.form_group).toBe("form#checkout");
    expect(pay.properties.is_disabled).toBe(true);

    const search = extract.interactive_nodes.find((n) => n.accessible_name === "Search products")!;
    expect(search.form_group).toMatch(/^form:nth\(\d+\)$/); // anonymous form gets an index

    const toggle = nodeByTestId(extract, "pref-toggle");
    expect(toggle.form_group).toBe("section#prefs"); // section landmark fallback
  });
});

/* ------------------------------------------------------------------ */

describe("visibility resolution (each rule)", () => {
  const cases: Array<{ id: string; visible: boolean; rule: string }> = [
    { id: "v-display", visible: false, rule: "display:none on ancestor" },
    { id: "v-vis", visible: false, rule: "visibility:hidden on self" },
    { id: "v-opacity", visible: false, rule: "opacity:0 on ancestor" },
    { id: "v-hidden-attr", visible: false, rule: "hidden attribute" },
    { id: "v-aria", visible: false, rule: "aria-hidden=true on ancestor" },
    { id: "v-zero", visible: false, rule: "zero-size bounding box" },
    { id: "v-fixed", visible: true, rule: "position:fixed is exempt from the offsetParent rule" },
    { id: "v-normal", visible: true, rule: "control case" },
  ];

  it("flags hidden nodes but still includes them", async () => {
    fx.route(
      "/visibility",
      htmlPage(`
        <div style="display:none"><button data-testid="v-display">A</button></div>
        <button data-testid="v-vis" style="visibility:hidden">B</button>
        <div style="opacity:0"><button data-testid="v-opacity">C</button></div>
        <button data-testid="v-hidden-attr" hidden>D</button>
        <div aria-hidden="true"><button data-testid="v-aria">E</button></div>
        <div data-testid="v-zero" role="button" tabindex="0"
             style="position:absolute;width:0;height:0;overflow:hidden;padding:0;border:0"></div>
        <button data-testid="v-fixed" style="position:fixed;top:0;left:0">F</button>
        <button data-testid="v-normal">G</button>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/visibility`)));
    for (const c of cases) {
      const node = nodeByTestId(extract, c.id);
      expect(node.properties.is_visible, `${c.id}: ${c.rule}`).toBe(c.visible);
    }
  });

  it("include_hidden=false drops hidden nodes and says so in notes", async () => {
    const extract = assertValidExtract(
      await extractSemanticDom(input(`${fx.base}/visibility`, { include_hidden: false })),
    );
    const ids = ["v-display", "v-vis", "v-opacity", "v-hidden-attr", "v-aria", "v-zero"];
    for (const id of ids) {
      expect(
        extract.interactive_nodes.some((n) => n.primary_locator.playwright === `getByTestId('${id}')`),
        id,
      ).toBe(false);
    }
    expect(extract.page_metadata.notes.join(" ")).toMatch(/hidden node\(s\) excluded/);
    nodeByTestId(extract, "v-normal"); // visible ones survive
  });
});

/* ------------------------------------------------------------------ */

describe("locator derivation", () => {
  it("falls back to role + accessible name when no id/test attribute exists", async () => {
    fx.route("/no-testid", htmlPage(`<main><button>Continue</button></main>`));
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/no-testid`)));
    const btn = extract.interactive_nodes.find((n) => n.tag === "button")!;
    expect(btn.primary_locator.strategy).toBe("role");
    expect(btn.primary_locator.playwright).toBe("getByRole('button', { name: 'Continue' })");
    expect(btn.primary_locator.is_unique).toBe(true);
  });

  it("prefers test-id and orders fallbacks label > placeholder > id", async () => {
    fx.route(
      "/priority",
      htmlPage(`
        <label for="user-email-field">Email address</label>
        <input id="user-email-field" data-testid="input-email" type="email" placeholder="Enter your email">`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/priority`)));
    const node = nodeByTestId(extract, "input-email");
    expect(node.primary_locator).toMatchObject({
      strategy: "test-id",
      playwright: "getByTestId('input-email')",
      is_unique: true,
    });
    const strategies = node.fallback_locators.map((l) => l.strategy);
    expect(strategies.indexOf("label")).toBeLessThan(strategies.indexOf("placeholder"));
    expect(strategies.indexOf("placeholder")).toBeLessThan(strategies.indexOf("id"));
    expect(node.fallback_locators.find((l) => l.strategy === "id")!.playwright).toBe(
      "locator('#user-email-field')",
    );
  });

  it("flags ambiguous locators with is_unique:false and disambiguation guidance", async () => {
    fx.route(
      "/ambiguous",
      htmlPage(`
        <div><button class="save">Save</button></div>
        <div data-testid="card-2"><button class="save">Save</button></div>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/ambiguous`)));
    const saves = extract.interactive_nodes.filter(
      (n) => n.tag === "button" && n.accessible_name === "Save",
    );
    expect(saves).toHaveLength(2);
    for (const save of saves) {
      expect(save.primary_locator.strategy).toBe("role"); // structural css never wins primary
      expect(save.primary_locator.is_unique).toBe(false);
      expect(save.primary_locator.disambiguation).toBeDefined();
    }
    expect(saves[0]!.primary_locator.disambiguation).toContain(".nth(0)");
    expect(saves[1]!.primary_locator.disambiguation).toContain(".nth(1)");
    expect(saves[1]!.primary_locator.disambiguation).toContain("getByTestId('card-2')");
  });
});

/* ------------------------------------------------------------------ */

describe("shadow DOM", () => {
  it("pierces open shadow roots, flags in_shadow, and never emits shadow CSS", async () => {
    fx.route(
      "/open-shadow",
      htmlPage(`
        <div id="host"></div>
        <script>
          const root = document.getElementById("host").attachShadow({ mode: "open" });
          root.innerHTML = '<button data-testid="shadow-btn">Inside shadow</button>';
        </script>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/open-shadow`)));
    const btn = nodeByTestId(extract, "shadow-btn");
    expect(btn.in_shadow).toBe(true);
    expect(btn.primary_locator).toMatchObject({
      strategy: "test-id",
      playwright: "getByTestId('shadow-btn')",
      is_unique: true, // Playwright's engine pierced the open shadow root
    });
    // no structural css candidate for shadow nodes (would be shadow-piercing)
    expect(btn.fallback_locators.every((l) => !l.playwright.includes("nth-child"))).toBe(true);
  });

  it("emits a shadow_boundary marker for closed shadow roots, without touching contents", async () => {
    fx.route(
      "/closed-shadow",
      htmlPage(`
        <div id="closed-host"></div>
        <script>
          const root = document.getElementById("closed-host").attachShadow({ mode: "closed" });
          root.innerHTML = '<button data-testid="secret-btn">Secret</button>';
        </script>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/closed-shadow`)));
    const boundary = extract.interactive_nodes.find((n) => n.kind === "shadow_boundary")!;
    expect(boundary).toBeDefined();
    expect(boundary.context_note).toMatch(/Closed shadow root/);
    expect(boundary.primary_locator.playwright).toBe("locator('#closed-host')");
    // contents were never extracted
    expect(
      extract.interactive_nodes.some((n) => n.primary_locator.playwright.includes("secret-btn")),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("iframes", () => {
  it("extracts same-origin iframe contents with frame_path set", async () => {
    fx.route("/frame-child", htmlPage(`<button data-testid="frame-btn">In frame</button>`));
    fx.route(
      "/frame-parent",
      htmlPage(`<h1>Main</h1><iframe id="kid" src="/frame-child"></iframe>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/frame-parent`)));
    expect(extract.page_metadata.frame_count).toBe(2);
    const btn = nodeByTestId(extract, "frame-btn");
    expect(btn.frame_path).toEqual(["iframe#kid"]);
    expect(btn.primary_locator.is_unique).toBe(true);
  });

  it("records cross-origin iframes as opaque marker nodes, never accessing their DOM", async () => {
    fx.route("/foreign-child", htmlPage(`<button data-testid="foreign-btn">Foreign</button>`));
    fx.route(
      "/xorigin-parent",
      htmlPage(`<h1>Main</h1><iframe id="foreign" src="${fx.altBase}/foreign-child"></iframe>`),
    );
    const extract = assertValidExtract(await extractSemanticDom(input(`${fx.base}/xorigin-parent`)));
    const marker = extract.interactive_nodes.find((n) => n.kind === "cross_origin_frame")!;
    expect(marker).toBeDefined();
    expect(marker.tag).toBe("iframe");
    expect(marker.frame_path).toEqual([]); // the marker lives in the main document
    expect(marker.primary_locator.playwright).toBe("locator('iframe#foreign')");
    expect(marker.context_note).toMatch(/unreachable/i);
    expect(marker.context_note).toContain(`${fx.altBase}/foreign-child`);
    // nothing inside the foreign frame leaked into the extraction
    expect(
      extract.interactive_nodes.some((n) => n.primary_locator.playwright.includes("foreign-btn")),
    ).toBe(false);
  });

  it("list_frames reports the frame tree with origin classification", async () => {
    const frames = await listFrames(`${fx.base}/xorigin-parent`, "load");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ frame_path: [], same_origin: true, reachable: true });
    expect(frames[1]).toMatchObject({
      frame_path: ["iframe#foreign"],
      same_origin: false,
      reachable: false,
    });
  });
});

/* ------------------------------------------------------------------ */

describe("caps (MAX_NODES / truncation)", () => {
  it("stops at max_nodes and flags truncation in metadata + notes", async () => {
    const buttons = Array.from({ length: 30 }, (_, i) => `<button data-testid="b${i}">Btn ${i}</button>`).join("");
    fx.route("/many", htmlPage(buttons));
    const extract = assertValidExtract(
      await extractSemanticDom(input(`${fx.base}/many`, { max_nodes: 5 })),
    );
    expect(extract.interactive_nodes).toHaveLength(5);
    expect(extract.page_metadata.truncated).toBe(true);
    expect(extract.page_metadata.notes.join(" ")).toMatch(/MAX_NODES \(5\) hit/);
  });
});

/* ------------------------------------------------------------------ */

describe("guardrails", () => {
  it("refuses hosts outside the allowlist with a structured error", async () => {
    await expect(extractSemanticDom(input("https://example.com/"))).rejects.toMatchObject({
      code: "url_not_allowed",
    });
  });

  it("reports wait_selector timeouts as structured errors", async () => {
    fx.route("/plain", htmlPage(`<button>Hi</button>`));
    await expect(
      extractSemanticDom(input(`${fx.base}/plain`, { wait_selector: "#never-appears" })),
    ).rejects.toMatchObject({ code: "wait_selector_timeout" });
  }, 30_000);
});
