/**
 * Snapshot diff: what changed between two SemanticExtracts.
 *
 * A post-interaction extraction repeats everything the agent already saw —
 * the login-page snapshot in the first A/B run cost ~5k tokens and the
 * post-login one ~5k again, though only a handful of nodes differed. The
 * diff returns just those nodes, and "what appeared after the click" is
 * exactly the assertion list a test needs.
 *
 * Identity must survive the transitions a test cares about most: a hidden
 * menu item becoming visible changes its *resolved* primary locator
 * (getByRole skips hidden elements, so the hidden state resolves to
 * getByText), but not what the element is. So identity is built from the
 * most stable fact available, in order: a test-id locator → an id locator →
 * a placeholder locator → tag + role + accessible name; plus frame_path and a
 * document-order index so non-unique nodes (list rows) still pair up. The
 * resolved primary locator is then reported as an ordinary change, which
 * tells the agent which expression is valid in which state.
 */
import type { ChangedNode, FieldChange, InteractiveNode, Locator, RemovedNodeRef, SemanticDiff, SemanticExtract } from "./types.js";

const IDENTITY_STRATEGIES: ReadonlyArray<Locator["strategy"]> = ["test-id", "id", "placeholder"];

/** Stable per-element identity (see module doc). */
export function identityKey(node: InteractiveNode): string {
  const locators = [node.primary_locator, ...node.fallback_locators];
  for (const strategy of IDENTITY_STRATEGIES) {
    const hit = locators.find((l) => l.strategy === strategy);
    if (hit) return `${node.frame_path.join(">")}|${strategy}:${hit.playwright}`;
  }
  return `${node.frame_path.join(">")}|${node.tag}|${node.role ?? ""}|${node.accessible_name ?? ""}`;
}

function keyed(nodes: InteractiveNode[]): Map<string, InteractiveNode> {
  const seen = new Map<string, number>();
  const out = new Map<string, InteractiveNode>();
  for (const node of nodes) {
    const base = identityKey(node);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, node);
  }
  return out;
}

/** Flat projection of every field a test can assert on, keyed by change path. */
function comparable(node: InteractiveNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: node.role,
    accessible_name: node.accessible_name,
    form_group: node.form_group,
    context_note: node.context_note ?? null,
    "primary_locator.playwright": node.primary_locator.playwright,
    "primary_locator.is_unique": node.primary_locator.is_unique,
  };
  for (const [k, v] of Object.entries(node.properties)) out[`properties.${k}`] = v;
  return out;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b); // only `options` reaches here
}

function changesBetween(before: InteractiveNode, after: InteractiveNode): Record<string, FieldChange> {
  const b = comparable(before);
  const a = comparable(after);
  const changes: Record<string, FieldChange> = {};
  for (const key of Object.keys(a)) {
    if (!same(b[key], a[key])) changes[key] = { from: b[key] ?? null, to: a[key] ?? null };
  }
  return changes;
}

export function diffExtracts(before: SemanticExtract, after: SemanticExtract): SemanticDiff {
  const beforeMap = keyed(before.interactive_nodes);
  const afterMap = keyed(after.interactive_nodes);

  const added: InteractiveNode[] = [];
  const removed: RemovedNodeRef[] = [];
  const changed: ChangedNode[] = [];
  let unchanged = 0;

  for (const [key, node] of afterMap) {
    const prev = beforeMap.get(key);
    if (!prev) {
      added.push(node);
      continue;
    }
    const changes = changesBetween(prev, node);
    if (Object.keys(changes).length === 0) unchanged++;
    else changed.push({ node, changes });
  }
  for (const [key, node] of beforeMap) {
    if (!afterMap.has(key)) {
      removed.push({
        frame_path: node.frame_path,
        role: node.role,
        accessible_name: node.accessible_name,
        primary_locator: node.primary_locator,
      });
    }
  }

  const notes: string[] = [];
  if (before.page_metadata.url !== after.page_metadata.url) {
    notes.push("The page URL changed between snapshots; a large added/removed set is expected after navigation.");
  }
  if (before.page_metadata.truncated || after.page_metadata.truncated) {
    notes.push("At least one snapshot was truncated; nodes past the cap cannot be compared.");
  }
  // The identity rule itself is documented once, in the session_extract tool description.

  return {
    schema_version: "1.3",
    kind: "diff",
    from_snapshot: before.snapshot_id ?? 0,
    to_snapshot: after.snapshot_id ?? 0,
    page_metadata: {
      url_before: before.page_metadata.url,
      url_after: after.page_metadata.url,
      title_before: before.page_metadata.title,
      title_after: after.page_metadata.title,
      captured_at: after.page_metadata.captured_at,
      notes,
    },
    summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged },
    added,
    removed,
    changed,
    ...(after.observed ? { observed: after.observed } : {}),
  };
}
