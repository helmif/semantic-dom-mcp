import { describe, expect, it } from "vitest";
import { diffExtracts } from "../src/diff.js";
import { emptyProperties, type InteractiveNode, type SemanticExtract } from "../src/types.js";
import { semanticDiffSchema } from "./helpers.js";

/* Pure unit tests: no browser. The identity rule and change detection are
 * what make a diff trustworthy, so they are pinned here explicitly. */

function node(overrides: Partial<InteractiveNode> & { playwright: string; is_unique?: boolean }): InteractiveNode {
  const { playwright, is_unique = true, ...rest } = overrides;
  return {
    kind: "element",
    tag: "button",
    role: "button",
    in_shadow: false,
    frame_path: [],
    form_group: null,
    accessible_name: "Save",
    primary_locator: { strategy: "role", playwright, is_unique },
    fallback_locators: [],
    properties: emptyProperties({ type: "button", text_content: "Save", is_disabled: false }),
    ...rest,
  };
}

let seq = 0;
function extract(nodes: InteractiveNode[], url = "http://x/a"): SemanticExtract {
  return {
    schema_version: "1.4",
    snapshot_id: ++seq,
    page_metadata: {
      title: "t",
      url,
      captured_at: new Date().toISOString(),
      node_count: nodes.length,
      frame_count: 1,
      truncated: false,
      notes: [],
    },
    interactive_nodes: nodes,
  };
}

describe("diffExtracts", () => {
  it("classifies added, removed, changed and unchanged nodes", () => {
    const save = node({ playwright: "getByRole('button', { name: 'Save' })" });
    const cancel = node({ playwright: "getByRole('button', { name: 'Cancel' })", accessible_name: "Cancel" });
    const before = extract([save, cancel]);

    const saveDisabled = { ...save, properties: { ...save.properties, is_disabled: true } };
    const toast = node({ playwright: "getByRole('alert')", role: "alert", tag: "div", accessible_name: "Saved" });
    const after = extract([saveDisabled, toast]);

    const diff = semanticDiffSchema.parse(diffExtracts(before, after));
    expect(diff.from_snapshot).toBe(before.snapshot_id);
    expect(diff.to_snapshot).toBe(after.snapshot_id);
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 0 });
    expect(diff.added[0]!.role).toBe("alert");
    expect(diff.removed[0]!.accessible_name).toBe("Cancel");
    expect(diff.changed[0]!.changes).toEqual({ "properties.is_disabled": { from: false, to: true } });
  });

  it("pairs non-unique locators by document order instead of collapsing them", () => {
    const row = (i: number, disabled = false) =>
      node({
        playwright: "getByRole('button', { name: 'Delete' })",
        is_unique: false,
        accessible_name: "Delete",
        properties: { ...node({ playwright: "" }).properties, is_disabled: disabled },
        context_note: `row ${i}`,
      });
    const before = extract([row(0), row(1), row(2)]);
    const after = extract([row(0), row(1, true)]); // third row gone, second disabled

    const diff = diffExtracts(before, after);
    expect(diff.summary).toEqual({ added: 0, removed: 1, changed: 1, unchanged: 1 });
    expect(diff.removed[0]!.primary_locator.is_unique).toBe(false);
    expect(diff.changed[0]!.changes["properties.is_disabled"]).toEqual({ from: false, to: true });
  });

  it("keeps frames apart and notes URL changes", () => {
    const main = node({ playwright: "getByRole('button', { name: 'Save' })" });
    const framed = { ...main, frame_path: ["iframe#pay"] };
    const before = extract([main, framed], "http://x/a");
    const after = extract([main], "http://x/b");

    const diff = diffExtracts(before, after);
    expect(diff.summary.removed).toBe(1);
    expect(diff.removed[0]!.frame_path).toEqual(["iframe#pay"]);
    expect(diff.page_metadata.url_before).toBe("http://x/a");
    expect(diff.page_metadata.url_after).toBe("http://x/b");
    expect(diff.page_metadata.notes.some((n) => /URL changed/.test(n))).toBe(true);
  });

  it("carries the after-snapshot's observed behavior", () => {
    const before = extract([]);
    const after: SemanticExtract = {
      ...extract([]),
      observed: {
        duration_ms: 10,
        navigations: [{ from: "http://x/a", to: "http://x/b", at_ms: 5 }],
        requests: [],
        console_errors: [],
        dialogs: [],
        popups: [],
        dropped: { requests: 0, console_errors: 0 },
      },
    };
    const diff = diffExtracts(before, after);
    expect(diff.observed?.navigations[0]!.to).toBe("http://x/b");
  });

  it("keeps identity across a primary-locator change when a stable attribute or name is shared", async () => {
    // Hidden menu item resolves to getByText; visible, to getByRole. Same element.
    const hidden = node({
      playwright: "getByText('Profil')",
      role: "menuitem",
      tag: "a",
      accessible_name: "Profil",
      properties: emptyProperties({ is_visible: false, text_content: "Profil" }),
    });
    const shown = {
      ...hidden,
      primary_locator: { strategy: "role" as const, playwright: "getByRole('menuitem', { name: 'Profil' })", is_unique: true },
      properties: emptyProperties({ is_visible: true, text_content: "Profil" }),
    };
    const diff = diffExtracts(extract([hidden]), extract([shown]));
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
    expect(diff.changed[0]!.changes["primary_locator.playwright"]).toEqual({
      from: "getByText('Profil')",
      to: "getByRole('menuitem', { name: 'Profil' })",
    });

    // A relabelled button keeps identity through its test-id fallback.
    const save = node({
      playwright: "getByRole('button', { name: 'Save' })",
      fallback_locators: [{ strategy: "test-id", playwright: "getByTestId('save')", is_unique: true }],
    });
    const saving = {
      ...save,
      accessible_name: "Saving…",
      primary_locator: { strategy: "role" as const, playwright: "getByRole('button', { name: 'Saving…' })", is_unique: true },
      properties: emptyProperties({ type: "button", text_content: "Saving…", is_disabled: true }),
    };
    const d2 = diffExtracts(extract([save]), extract([saving]));
    expect(d2.summary).toEqual({ added: 0, removed: 0, changed: 1, unchanged: 0 });
    expect(Object.keys(d2.changed[0]!.changes).sort()).toEqual([
      "accessible_name",
      "primary_locator.playwright",
      "properties.is_disabled",
      "properties.text_content",
    ]);

    // Without any stable attribute, a renamed node is removed + added (documented boundary).
    const d3 = diffExtracts(extract([node({ playwright: "getByRole('button', { name: 'Save' })" })]), extract([{ ...saving, fallback_locators: [] }]));
    expect(d3.summary).toEqual({ added: 1, removed: 1, changed: 0, unchanged: 0 });
  });
});
