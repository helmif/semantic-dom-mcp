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
  route(path: string, html: string): void;
  close(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const routes = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const html = routes.get(req.url ?? "");
    if (html === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    altBase: `http://localhost:${port}`,
    route: (path, html) => void routes.set(path, html),
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
  })
  .strict();

export const semanticExtractSchema = z
  .object({
    schema_version: z.literal("1.1"),
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
