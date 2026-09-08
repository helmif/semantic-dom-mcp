/**
 * Wire compaction (schema 1.3): the same facts in about a third of the tokens.
 *
 * Measured on real v0.5 output a node cost 300–385 tokens; most of it was
 * indentation, `null` properties, fallback locators nobody needs when the
 * primary is unique, and text repeated between `text_content` and
 * `accessible_name`. Internally every extract keeps the full, fixed shape
 * (types.ts) so diffing and tests reason about one structure; this module
 * runs once at the tool-result boundary.
 *
 * Rules, all lossless for an agent reading the result:
 *   - a node key whose value is `null` is omitted (absent = null);
 *   - `frame_path: []`, `in_shadow: false`, `kind: "element"`,
 *     `fallback_locators: []` are omitted (absent = that default);
 *   - `properties.text_content` is omitted when it equals `accessible_name`;
 *   - fallback locators are kept only when the primary is not unique or is a
 *     brittle strategy (css/id), and capped at 2;
 *   - `is_visible` is always present: a test asserts it either way.
 * Diff `changes` entries keep `null` from/to values: there the null is the fact.
 */
import type { InteractiveNode, Locator, RemovedNodeRef, SemanticDiff, SemanticExtract } from "./types.js";

const MAX_WIRE_FALLBACKS = 2;
const BRITTLE: ReadonlySet<Locator["strategy"]> = new Set(["css", "id"]);

type Json = Record<string, unknown>;

function dropNulls(obj: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function compactNode(node: InteractiveNode): Json {
  const props: Json = dropNulls(node.properties as unknown as Json);
  if (node.properties.text_content !== null && node.properties.text_content === node.accessible_name) delete props["text_content"];

  const keepFallbacks = !node.primary_locator.is_unique || BRITTLE.has(node.primary_locator.strategy);
  const fallbacks = keepFallbacks ? node.fallback_locators.slice(0, MAX_WIRE_FALLBACKS) : [];

  const out: Json = dropNulls({
    kind: node.kind === "element" ? null : node.kind,
    tag: node.tag,
    role: node.role,
    in_shadow: node.in_shadow ? true : null,
    frame_path: node.frame_path.length > 0 ? node.frame_path : null,
    form_group: node.form_group,
    accessible_name: node.accessible_name,
    primary_locator: node.primary_locator,
    fallback_locators: fallbacks.length > 0 ? fallbacks : null,
    properties: props,
    context_note: node.context_note ?? null,
  });
  return out;
}

function compactRemoved(ref: RemovedNodeRef): Json {
  return dropNulls({
    frame_path: ref.frame_path.length > 0 ? ref.frame_path : null,
    role: ref.role,
    accessible_name: ref.accessible_name,
    primary_locator: ref.primary_locator,
  });
}

function isExtract(v: unknown): v is SemanticExtract {
  return !!v && typeof v === "object" && Array.isArray((v as SemanticExtract).interactive_nodes);
}
function isDiff(v: unknown): v is SemanticDiff {
  return !!v && typeof v === "object" && (v as SemanticDiff).kind === "diff";
}

/** Applies the wire rules to an extract or a diff; any other value passes through untouched. */
export function compactForWire<T>(value: T): T | Json {
  if (isExtract(value)) {
    return { ...value, interactive_nodes: value.interactive_nodes.map(compactNode) };
  }
  if (isDiff(value)) {
    return {
      ...value,
      added: value.added.map(compactNode),
      removed: value.removed.map(compactRemoved),
      changed: value.changed.map((c) => ({ node: compactNode(c.node), changes: c.changes })),
    };
  }
  return value;
}
