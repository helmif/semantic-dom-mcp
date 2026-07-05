export type NodeKind = "element" | "shadow_boundary" | "cross_origin_frame";

export type LocatorStrategy =
  | "test-id" | "role" | "label" | "placeholder" | "text" | "id" | "css";

export interface Locator {
  strategy: LocatorStrategy;
  playwright: string;          // ready-to-paste Playwright expression
  is_unique: boolean;          // matches exactly one element in its frame
  disambiguation?: string;     // present only when is_unique is false
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

export interface SemanticExtract {
  schema_version: "1.1";       // 1.1 adds properties.href (additive)
  page_metadata: PageMetadata;
  interactive_nodes: InteractiveNode[];
}
