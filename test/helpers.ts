import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { SemanticExtract } from "../src/types.js";

/* ------------------------------------------------------------------ */
/* Fixture HTTP server (serves registered HTML pages on an ephemeral    */
/* port; reachable as both 127.0.0.1 and localhost, which are DIFFERENT */
/* origins — used for the cross-origin iframe fixture)                  */
/* ------------------------------------------------------------------ */

export interface FixtureServer {
  port: number;
  /** http://127.0.0.1:<port> */
  base: string;
  /** http://localhost:<port> — a different origin than `base`. */
  altBase: string;
  route(path: string, html: string, delayMs?: number): void;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, { html: string; delayMs: number }>();
  const server = http.createServer((req, res) => {
    // Match on pathname: fixtures that fetch('/api/x?q=1') must hit '/api/x'.
    const entry = routes.get(new URL(req.url ?? "/", "http://fixture").pathname);
    if (entry === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(entry.html);
    }, entry.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    altBase: `http://localhost:${port}`,
    route: (path, html, delayMs = 0) => void routes.set(path, { html, delayMs }),
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

export function htmlPage(body: string, title = "Fixture"): string {
  // The viewport meta matches real-world pages; without it, mobile emulation
  // falls back to the 980px legacy layout viewport and media queries misfire.
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body>${body}</body></html>`;
}

/* ------------------------------------------------------------------ */
/* Contract validation — zod mirror of the frozen contract interfaces.  */
/* Every extraction in the suite must pass this.                        */
/* ------------------------------------------------------------------ */

const locatorSchema = z
  .object({
    strategy: z.enum(["test-id", "role", "label", "placeholder", "text", "id", "css"]),
    playwright: z.string().min(1),
    is_unique: z.boolean(),
    disambiguation: z.string().optional(),
    within: z.object({ kind: z.enum(["row", "listitem", "test-id", "css"]), value: z.string().min(1) }).strict().optional(),
  })
  .strict();

const propertiesSchema = z
  .object({
    type: z.string().nullable(),
    placeholder: z.string().nullable(),
    text_content: z.string().nullable(),
    href: z.string().nullable(),
    is_required: z.boolean().nullable(),
    is_disabled: z.boolean().nullable(),
    is_checked: z.boolean().nullable(),
    is_visible: z.boolean(),
    value: z.string().nullable(),
    aria_expanded: z.boolean().nullable(),
    aria_selected: z.boolean().nullable(),
    aria_invalid: z.boolean().nullable(),
    described_by: z.string().nullable(),
    validation_message: z.string().nullable(),
    options: z.array(z.object({ value: z.string(), label: z.string(), selected: z.boolean() }).strict()).nullable(),
  })
  .strict();

const observedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    navigations: z.array(z.object({ from: z.string(), to: z.string(), at_ms: z.number().int() }).strict()),
    requests: z.array(
      z
        .object({
          method: z.string(),
          url: z.string().refine((u) => !u.includes("?"), "query strings must be stripped"),
          status: z.number().int().nullable(),
          resource_type: z.string(),
          failed: z.string().optional(),
        })
        .strict(),
    ),
    console_errors: z.array(z.object({ level: z.enum(["error", "warning"]), text: z.string() }).strict()),
    dialogs: z.array(z.object({ type: z.string(), message: z.string(), handled: z.literal("dismissed") }).strict()),
    popups: z.array(z.object({ url: z.string(), handled: z.literal("closed") }).strict()),
    dropped: z.object({ requests: z.number().int().nonnegative(), console_errors: z.number().int().nonnegative() }).strict(),
  })
  .strict();

const nodeSchema = z
  .object({
    kind: z.enum(["element", "shadow_boundary", "cross_origin_frame"]),
    tag: z.string().min(1),
    role: z.string().nullable(),
    in_shadow: z.boolean(),
    frame_path: z.array(z.string()),
    form_group: z.string().nullable(),
    accessible_name: z.string().nullable(),
    primary_locator: locatorSchema,
    fallback_locators: z.array(locatorSchema),
    properties: propertiesSchema,
    context_note: z.string().optional(),
    identity: z.string().optional(),
  })
  .strict();

export const semanticExtractSchema = z
  .object({
    schema_version: z.literal("1.5"),
    page_metadata: z
      .object({
        title: z.string(),
        url: z.string(),
        captured_at: z.string().datetime(),
        node_count: z.number().int().nonnegative(),
        frame_count: z.number().int().positive(),
        truncated: z.boolean(),
        notes: z.array(z.string()),
      })
      .strict(),
    interactive_nodes: z.array(nodeSchema),
    observed: observedSchema.optional(),
    snapshot_id: z.number().int().positive().optional(),
    tables: z
      .array(
        z
          .object({
            selector: z.string(),
            name: z.string().nullable(),
            headers: z.array(z.string()),
            row_count: z.number().int().nonnegative(),
            rows: z.array(z.object({ identity: z.string().nullable(), cells: z.record(z.string()) }).strict()),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .optional(),
    dialogs: z
      .array(z.object({ selector: z.string(), name: z.string().nullable(), is_visible: z.boolean(), text: z.string(), fields: z.record(z.string()) }).strict())
      .optional(),
    omitted: z.object({ nodes: z.number().int().positive(), reason: z.string() }).strict().optional(),
  })
  .strict();

export const semanticDiffSchema = z
  .object({
    schema_version: z.literal("1.5"),
    kind: z.literal("diff"),
    from_snapshot: z.number().int().positive(),
    to_snapshot: z.number().int().positive(),
    page_metadata: z
      .object({
        url_before: z.string(),
        url_after: z.string(),
        title_before: z.string(),
        title_after: z.string(),
        captured_at: z.string().datetime(),
        notes: z.array(z.string()),
      })
      .strict(),
    summary: z
      .object({
        added: z.number().int().nonnegative(),
        removed: z.number().int().nonnegative(),
        changed: z.number().int().nonnegative(),
        unchanged: z.number().int().nonnegative(),
      })
      .strict(),
    added: z.array(nodeSchema),
    removed: z.array(
      z
        .object({
          frame_path: z.array(z.string()),
          role: z.string().nullable(),
          accessible_name: z.string().nullable(),
          primary_locator: locatorSchema,
        })
        .strict(),
    ),
    changed: z.array(
      z
        .object({
          node: nodeSchema,
          changes: z.record(z.object({ from: z.unknown(), to: z.unknown() }).strict()),
        })
        .strict(),
    ),
    observed: observedSchema.optional(),
  })
  .strict();

/** Validates the contract and cross-field invariants; returns the input. */
export function assertValidExtract(extract: SemanticExtract): SemanticExtract {
  semanticExtractSchema.parse(extract);
  if (extract.page_metadata.node_count !== extract.interactive_nodes.length) {
    throw new Error("node_count does not match interactive_nodes.length");
  }
  for (const node of extract.interactive_nodes) {
    for (const loc of [node.primary_locator, ...node.fallback_locators]) {
      if (loc.playwright.includes(">>>") || loc.playwright.includes("::shadow")) {
        throw new Error(`Shadow-piercing CSS emitted: ${loc.playwright}`);
      }
    }
  }
  return extract;
}

/** Plain extract_semantic_dom output must carry no session/behavior fields. */
export function assertReadOnlyExtract(extract: SemanticExtract): SemanticExtract {
  assertValidExtract(extract);
  if ("observed" in extract || "snapshot_id" in extract) {
    throw new Error("read-only extraction must not carry observed/snapshot_id");
  }
  return extract;
}

export function nodesByTestId(extract: SemanticExtract, testId: string) {
  return extract.interactive_nodes.filter((n) =>
    [n.primary_locator, ...n.fallback_locators].some(
      (l) => l.strategy === "test-id" && l.playwright === `getByTestId('${testId}')`,
    ),
  );
}

export function nodeByTestId(extract: SemanticExtract, testId: string) {
  const matches = nodesByTestId(extract, testId);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly 1 node with test id '${testId}', found ${matches.length}`);
  }
  return matches[0]!;
}
