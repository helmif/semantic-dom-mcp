import { describe, expect, it } from "vitest";
import { compactForWire, compactNode } from "../src/compact.js";
import { diffExtracts } from "../src/diff.js";
import { emptyProperties, type InteractiveNode, type SemanticExtract } from "../src/types.js";

/* Pure unit tests for the schema 1.3 wire rules: what leaves the server must
 * be smaller but say the same thing. */

function node(overrides: Partial<InteractiveNode> = {}): InteractiveNode {
  return {
    kind: "element",
    tag: "button",
    role: "button",
    in_shadow: false,
    frame_path: [],
    form_group: null,
    accessible_name: "Simpan",
    primary_locator: { strategy: "role", playwright: "getByRole('button', { name: 'Simpan' })", is_unique: true },
    fallback_locators: [
      { strategy: "text", playwright: "getByText('Simpan')", is_unique: true },
      { strategy: "css", playwright: "locator('html > body > button')", is_unique: true },
    ],
    properties: emptyProperties({ type: "submit", text_content: "Simpan", is_disabled: false }),
    ...overrides,
  };
}

function extract(nodes: InteractiveNode[]): SemanticExtract {
  return {
    schema_version: "1.3",
    page_metadata: { title: "t", url: "http://x/", captured_at: new Date().toISOString(), node_count: nodes.length, frame_count: 1, truncated: false, notes: [] },
    interactive_nodes: nodes,
  };
}

describe("wire compaction (schema 1.3)", () => {
  it("omits nulls and defaults, drops fallbacks for a unique semantic primary, dedupes text", () => {
    const wire = compactNode(node());
    expect(wire).toEqual({
      tag: "button",
      role: "button",
      accessible_name: "Simpan",
      primary_locator: { strategy: "role", playwright: "getByRole('button', { name: 'Simpan' })", is_unique: true },
      properties: { type: "submit", is_disabled: false, is_visible: true },
    });
    // No null anywhere, is_visible always present.
    expect(JSON.stringify(wire)).not.toContain("null");
  });

  it("keeps fallbacks (max 2) when the primary is ambiguous or brittle, and keeps non-default structure", () => {
    const ambiguous = compactNode(
      node({
        primary_locator: { strategy: "role", playwright: "getByRole('button', { name: 'Simpan' })", is_unique: false, disambiguation: "2 matches; use .nth(1)." },
        fallback_locators: [
          { strategy: "text", playwright: "getByText('Simpan')", is_unique: false },
          { strategy: "id", playwright: "locator('#save-2')", is_unique: true },
          { strategy: "css", playwright: "locator('html > body > button:nth-child(2)')", is_unique: true },
        ],
        frame_path: ["iframe#pay"],
        in_shadow: true,
        kind: "element",
      }),
    );
    expect(ambiguous.fallback_locators).toHaveLength(2);
    expect(ambiguous.frame_path).toEqual(["iframe#pay"]);
    expect(ambiguous.in_shadow).toBe(true);
    expect(ambiguous.primary_locator).toMatchObject({ disambiguation: "2 matches; use .nth(1)." });

    const brittle = compactNode(
      node({ primary_locator: { strategy: "id", playwright: "locator('#x')", is_unique: true }, fallback_locators: [{ strategy: "css", playwright: "locator('div')", is_unique: true }] }),
    );
    expect(brittle.fallback_locators).toHaveLength(1);

    const marker = compactNode(node({ kind: "cross_origin_frame", tag: "iframe", role: null, accessible_name: null, properties: emptyProperties({ is_visible: true }) }));
    expect(marker).toMatchObject({ kind: "cross_origin_frame", tag: "iframe" });
    expect("role" in marker).toBe(false);
  });

  it("keeps text_content when it differs from the accessible name", () => {
    const wire = compactNode(node({ accessible_name: "Sepatu Lari X", properties: emptyProperties({ text_content: "COD Sepatu Lari X Rp10.000" }) }));
    expect(wire.properties).toMatchObject({ text_content: "COD Sepatu Lari X Rp10.000" });
  });

  it("compacts extracts and diffs but keeps null from/to values inside diff changes", () => {
    const before = extract([node({ properties: emptyProperties({ aria_invalid: null, is_disabled: false }) })]);
    const after = extract([node({ properties: emptyProperties({ aria_invalid: true, is_disabled: true }) })]);
    before.snapshot_id = 1;
    after.snapshot_id = 2;
    const wire = compactForWire(diffExtracts(before, after)) as Record<string, unknown>;
    const changed = (wire.changed as Array<{ node: Record<string, unknown>; changes: Record<string, { from: unknown; to: unknown }> }>)[0]!;
    expect(changed.changes["properties.aria_invalid"]).toEqual({ from: null, to: true });
    expect("fallback_locators" in changed.node).toBe(false);

    const ex = compactForWire(before) as Record<string, unknown>;
    expect(JSON.stringify(ex)).not.toContain('"form_group"');
    // Non-extract values pass through untouched.
    expect(compactForWire({ session_id: "s_1", closed: true })).toEqual({ session_id: "s_1", closed: true });
  });

  it("is measurably smaller on a realistic node", () => {
    const full = JSON.stringify(node(), null, 2).length;
    const wire = JSON.stringify(compactNode(node())).length;
    expect(wire).toBeLessThan(full / 3);
  });
});
