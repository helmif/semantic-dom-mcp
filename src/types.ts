export type NodeKind = "element" | "shadow_boundary" | "cross_origin_frame";

export type LocatorStrategy =
  | "test-id" | "role" | "label" | "placeholder" | "text" | "id" | "css";

export interface Locator {
  strategy: LocatorStrategy;
  playwright: string;          // ready-to-paste Playwright expression
  is_unique: boolean;          // matches exactly one element in its frame
  disambiguation?: string;     // present only when is_unique is false
}

/** One <option> of a <select> (schema 1.2). */
export interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
}

export interface NodeProperties {
  type: string | null;
  placeholder: string | null;
  text_content: string | null;
  href: string | null;         // absolute, links only (schema 1.1); lets agents discover navigable pages
  is_required: boolean | null;
  is_disabled: boolean | null;
  is_checked: boolean | null;
  is_visible: boolean;
  // --- schema 1.2: assertable state ---
  /** Current value of input/select/textarea. Always null for password fields. */
  value: string | null;
  aria_expanded: boolean | null;
  aria_selected: boolean | null;
  aria_invalid: boolean | null;
  /** Text of the element(s) referenced by aria-describedby (hints, validation messages). */
  described_by: string | null;
  /** Browser constraint-validation message when the field is currently invalid. */
  validation_message: string | null;
  /** <select> options (capped at 50); null for every other element. */
  options: SelectOption[] | null;
}

/** All-null properties (markers, tests); pass what applies. */
export function emptyProperties(overrides: Partial<NodeProperties> = {}): NodeProperties {
  return {
    type: null,
    placeholder: null,
    text_content: null,
    href: null,
    is_required: null,
    is_disabled: null,
    is_checked: null,
    is_visible: true,
    value: null,
    aria_expanded: null,
    aria_selected: null,
    aria_invalid: null,
    described_by: null,
    validation_message: null,
    options: null,
    ...overrides,
  };
}

export interface InteractiveNode {
  kind: NodeKind;
  tag: string;
  role: string | null;
  in_shadow: boolean;
  frame_path: string[];        // [] = main document
  form_group: string | null;
  accessible_name: string | null;
  primary_locator: Locator;
  fallback_locators: Locator[];
  properties: NodeProperties;
  context_note?: string;
}

export interface PageMetadata {
  title: string;
  url: string;
  captured_at: string;         // ISO 8601
  node_count: number;
  frame_count: number;
  truncated: boolean;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Behavior observed while declared actions ran (schema 1.2)            */
/* ------------------------------------------------------------------ */

export interface ObservedNavigation {
  from: string;
  to: string;
  /** Milliseconds after observation started. */
  at_ms: number;
}

export interface ObservedRequest {
  method: string;
  /** Origin + path only — query strings are stripped (they may carry tokens). */
  url: string;
  /** null when the request never completed (see `failed`). */
  status: number | null;
  resource_type: string;
  failed?: string;
}

export interface ObservedConsoleMessage {
  level: "error" | "warning";
  text: string;
}

export interface ObservedDialog {
  type: string;
  message: string;
  handled: "dismissed";
}

export interface ObservedPopup {
  url: string;
  handled: "closed";
}

/**
 * Facts recorded while actions ran: what a test needs for waitForURL,
 * waitForResponse and console-error assertions. Observation only —
 * the server never issues requests of its own.
 */
export interface Observed {
  duration_ms: number;
  navigations: ObservedNavigation[];
  /** xhr/fetch/document requests only; static assets are counted in `dropped`. */
  requests: ObservedRequest[];
  console_errors: ObservedConsoleMessage[];
  dialogs: ObservedDialog[];
  popups: ObservedPopup[];
  /** Entries omitted due to caps or filters — never silent. */
  dropped: { requests: number; console_errors: number };
}

export interface SemanticExtract {
  schema_version: "1.2";       // 1.2 adds assertable properties, `observed`, and `snapshot_id` (additive)
  page_metadata: PageMetadata;
  interactive_nodes: InteractiveNode[];
  /**
   * Always present on extract_semantic_dom_after results (what happened while
   * the actions ran) and on session snapshots (everything since the previous
   * snapshot, possibly empty). Absent only on plain extract_semantic_dom.
   */
  observed?: Observed;
  /** Present on session snapshots; feeds `diff_against` in session_extract. */
  snapshot_id?: number;
}

/* ------------------------------------------------------------------ */
/* Snapshot diff (schema 1.2)                                           */
/* ------------------------------------------------------------------ */

/** Compact reference to a node that disappeared between snapshots. */
export interface RemovedNodeRef {
  frame_path: string[];
  role: string | null;
  accessible_name: string | null;
  primary_locator: Locator;
}

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export interface ChangedNode {
  node: InteractiveNode;
  /** Field name → { from, to }; nested properties are `properties.<name>`. */
  changes: Record<string, FieldChange>;
}

export interface SemanticDiff {
  schema_version: "1.2";
  kind: "diff";
  from_snapshot: number;
  to_snapshot: number;
  page_metadata: {
    url_before: string;
    url_after: string;
    title_before: string;
    title_after: string;
    captured_at: string;
    notes: string[];
  };
  summary: { added: number; removed: number; changed: number; unchanged: number };
  added: InteractiveNode[];
  removed: RemovedNodeRef[];
  changed: ChangedNode[];
  observed?: Observed;
}
