/**
 * Playwright layer and extraction orchestration.
 *
 * Owns: chromium launch/reuse, host allowlist enforcement
 * (QA_MCP_ALLOWED_HOSTS), storageState loading (QA_MCP_STORAGE_STATE),
 * navigation with wait_for / wait_selector, frame enumeration with origin
 * classification, per-frame in-page extraction, and SemanticExtract assembly.
 *
 * Zero-egress discipline: the only network activity is navigating the
 * browser to the allowlisted target URL. No telemetry, no other calls.
 * Logging goes to stderr and never includes page contents.
 */
import { existsSync, statSync } from "node:fs";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Frame, Page } from "playwright";
import { buildEvaluateExpression, buildOutlineExpression, CLOSED_SHADOW_INIT_SCRIPT } from "./extractor/inPage.js";
import type { RawOutline } from "./extractor/traverse.js";
import { LocatorParseError, parseLocatorExpression } from "./locatorExpr.js";
import { compactNode } from "./compact.js";
import { buildPwLocator, resolveLocators, type CountCache } from "./extractor/locators.js";
import type { RawExtractResult } from "./extractor/traverse.js";
import { observePage } from "./observe.js";
import { REDACTED, redactDeep, registerSecret } from "./secrets.js";
import { emptyProperties, type InteractiveNode, type LocatorStrategy, type SemanticExtract, type SemanticOutline } from "./types.js";
import { safeOrigin, stripQuery } from "./url.js";

const NAV_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const WAIT_SELECTOR_TIMEOUT_MS = 15_000;
export const MAX_DEPTH = 50;

/** Structured, agent-reactable failure — surfaced as tool content, not a crash. */
export class ExtractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

/* ------------------------------------------------------------------ */
/* Browser lifecycle (launch once, reuse across calls)                  */
/* ------------------------------------------------------------------ */

let browserPromise: Promise<Browser> | undefined;

/**
 * Launches once and reuses. A failed launch is not cached (the next call
 * retries, so installing the browser mid-session recovers), and a browser
 * that disconnects (crash, OOM kill) is forgotten so the next call relaunches.
 */
export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    console.error("[semantic-dom-mcp] launching chromium (headless)");
    const launching: Promise<Browser> = chromium
      .launch({ headless: true, timeout: LAUNCH_TIMEOUT_MS })
      .then((browser) => {
        browser.on("disconnected", () => {
          if (browserPromise === launching) {
            browserPromise = undefined;
            console.error("[semantic-dom-mcp] chromium disconnected; it will be relaunched on the next call");
          }
        });
        return browser;
      })
      .catch((err: unknown) => {
        if (browserPromise === launching) browserPromise = undefined;
        const msg = err instanceof Error ? err.message.split("\n")[0]! : String(err);
        throw new ExtractError(
          "browser_unavailable",
          `Chromium could not be launched: ${msg}`,
          "Install the matching browser with `npx -y -p semantic-dom-mcp playwright install chromium`, then retry.",
        );
      });
    browserPromise = launching;
  }
  return browserPromise;
}

/** Bounds a Playwright call that has no timeout of its own (evaluate, title). */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ExtractError(
            "page_unresponsive",
            `${what} did not complete within ${Math.round(ms / 1000)}s; the page's JavaScript may be blocked.`,
            "Retry after the page settles, or extract a different state; a session stuck this way can be closed.",
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
const EVALUATE_TIMEOUT_MS = 30_000;
const TITLE_TIMEOUT_MS = 5_000;

export function pageTitle(page: Page): Promise<string> {
  return withTimeout(page.title(), TITLE_TIMEOUT_MS, "Reading the page title").catch(() => "");
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const p = browserPromise;
    browserPromise = undefined;
    try {
      await (await p).close();
    } catch {
      // already gone
    }
  }
}

/* ------------------------------------------------------------------ */
/* URL scheme + host allowlist (default deny)                          */
/* ------------------------------------------------------------------ */

function allowedHosts(): string[] {
  return (process.env.QA_MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h.length > 0);
}

/**
 * Returns null when the URL may be navigated to, else a human-readable
 * refusal. Entries match the hostname exactly (case-insensitive); an entry
 * containing ':' must match host:port; a leading '*.' matches subdomains.
 */
export function checkUrlAllowed(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `Not a valid URL: ${rawUrl}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Only http/https URLs are allowed (got scheme '${url.protocol.replace(":", "")}').`;
  }
  const hosts = allowedHosts();
  if (hosts.length === 0) {
    return "QA_MCP_ALLOWED_HOSTS is not set. Set it to a comma-separated list of staging hostnames; navigation is denied by default.";
  }
  const hostname = url.hostname.toLowerCase();
  const hostWithPort = url.host.toLowerCase();
  for (const entry of hosts) {
    if (entry.startsWith("*.")) {
      if (hostname.endsWith(entry.slice(1)) || hostname === entry.slice(2)) return null;
    } else if (entry.includes(":")) {
      if (hostWithPort === entry) return null;
    } else if (hostname === entry) {
      return null;
    }
  }
  return `Host '${url.host}' is not in QA_MCP_ALLOWED_HOSTS (${hosts.join(", ")}).`;
}

/* ------------------------------------------------------------------ */
/* Context creation (storageState from env, closed-shadow init script)  */
/* ------------------------------------------------------------------ */

export type ViewportPreset = "desktop" | "mobile";

export async function newContext(browser: Browser, viewport: ViewportPreset = "desktop"): Promise<BrowserContext> {
  const storageState = process.env.QA_MCP_STORAGE_STATE;
  if (storageState && !existsSync(storageState)) {
    throw new ExtractError(
      "storage_state_missing",
      `QA_MCP_STORAGE_STATE points to '${storageState}' but the file does not exist.`,
      "Export a Playwright storageState JSON for the staging session, or unset the variable.",
    );
  }
  if (storageState) warnIfStorageStateReadable(storageState);
  const context = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    ...(viewport === "mobile"
      ? { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }
      : {}),
  });
  try {
    await context.addInitScript(CLOSED_SHADOW_INIT_SCRIPT);
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err;
  }
  return context;
}

let warnedStorageState = false;
/** A storageState file holds a live session; anyone who can read it is logged in. Warn once. */
export function storageStatePermissionProblem(path: string): string | null {
  if (process.platform === "win32") return null;
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) return `storage state '${path}' is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it.`;
  } catch {
    return null;
  }
  return null;
}
function warnIfStorageStateReadable(path: string): void {
  if (warnedStorageState) return;
  warnedStorageState = true;
  const problem = storageStatePermissionProblem(path);
  if (problem) console.error(`[semantic-dom-mcp] warning: ${problem}`);
}

/* ------------------------------------------------------------------ */
/* Frame enumeration with origin classification                        */
/* ------------------------------------------------------------------ */

export interface FrameEntry {
  frame: Frame;
  /** Chain of frame selectors from the main document ([] = main frame). */
  path: string[];
  /** Selector of this frame's <iframe> element within its parent frame. */
  selector: string | null;
  parent: FrameEntry | null;
  url: string;
  name: string;
  /** Same-origin relative to the main document. */
  sameOrigin: boolean;
  /** Reachable = same-origin AND every ancestor frame is reachable. */
  reachable: boolean;
}

async function frameSelector(frame: Frame): Promise<string | null> {
  try {
    const handle = await frame.frameElement();
    try {
      return await handle.evaluate((el: Element) => {
        const tag = el.tagName.toLowerCase();
        if (el.id) return `${tag}#${CSS.escape(el.id)}`;
        const name = el.getAttribute("name");
        if (name) return `${tag}[name="${name.replace(/"/g, '\\"')}"]`;
        const root = el.getRootNode() as Document | ShadowRoot;
        const all = root.querySelectorAll(tag);
        const idx = Array.prototype.indexOf.call(all, el);
        return `${tag} >> nth=${idx}`;
      });
    } finally {
      await handle.dispose();
    }
  } catch {
    return null;
  }
}

export async function enumerateFrames(page: Page): Promise<FrameEntry[]> {
  const mainOrigin = safeOrigin(page.url());
  const entries: FrameEntry[] = [];

  async function walk(frame: Frame, parent: FrameEntry | null): Promise<void> {
    const url = frame.url();
    const isMain = parent === null;
    const aboutBlank = url === "" || url.startsWith("about:");
    const sameOrigin = isMain || aboutBlank || (mainOrigin !== null && safeOrigin(url) === mainOrigin);
    const selector = isMain ? null : await frameSelector(frame);
    const entry: FrameEntry = {
      frame,
      selector,
      parent,
      url,
      name: frame.name(),
      sameOrigin,
      reachable: sameOrigin && (parent === null || parent.reachable),
      path: isMain ? [] : [...(parent?.path ?? []), selector ?? "iframe"],
    };
    entries.push(entry);
    // Children of unreachable frames are unreachable too — represented by the
    // parent's single opaque marker node, never descended into.
    if (entry.reachable) {
      for (const child of frame.childFrames()) {
        await walk(child, entry);
      }
    }
  }

  await walk(page.mainFrame(), null);
  return entries;
}

/* ------------------------------------------------------------------ */
/* Extraction orchestration                                             */
/* ------------------------------------------------------------------ */

export type WaitFor = "auto" | "load" | "domcontentloaded" | "networkidle";

export interface ExtractInput {
  url: string;
  wait_for: WaitFor;
  wait_selector?: string | undefined;
  include_hidden: boolean;
  max_nodes: number;
  viewport?: ViewportPreset | undefined;
  /** Opt-in heuristic: include cursor:pointer boundary elements with content
   * (JS-click cards) that match no other inclusion rule. Default false. */
  include_click_targets?: boolean | undefined;
  /** CSS selector to extract within (from an outline region's `selector`, or any). */
  scope?: string | undefined;
  /** Keep only nodes whose role or tag is listed. */
  roles?: string[] | undefined;
  /** Skip hidden nodes entirely (cheaper than include_hidden=false: they are never verified). */
  visible_only?: boolean | undefined;
  /** Budget for the node list; nodes beyond it are dropped in document order and counted in `omitted`. */
  max_output_chars?: number | undefined;
  /** Attach structured `tables` and `dialogs` found inside the scope. */
  include_tables?: boolean | undefined;
}

async function withPage<T>(fn: (page: Page) => Promise<T>, viewport?: ViewportPreset): Promise<T> {
  const browser = await getBrowser();
  const context = await newContext(browser, viewport ?? "desktop");
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function crossOriginMarker(entry: FrameEntry, notes: string[]): Promise<InteractiveNode> {
  const parentFrame = entry.parent?.frame;
  const selector = entry.selector ?? "iframe";
  let isUnique = false;
  let isVisible = true;
  if (parentFrame) {
    try {
      const loc = parentFrame.locator(selector);
      isUnique = (await loc.count()) === 1;
      isVisible = await loc.first().isVisible();
    } catch {
      notes.push(`Could not resolve the iframe element for cross-origin frame '${entry.url}'.`);
    }
  }
  return {
    kind: "cross_origin_frame",
    tag: "iframe",
    role: null,
    in_shadow: false,
    frame_path: entry.parent?.path ?? [],
    form_group: null,
    accessible_name: entry.name || null,
    primary_locator: {
      strategy: "css",
      playwright: `locator('${selector.replace(/'/g, "\\'")}')`,
      is_unique: isUnique,
      ...(isUnique ? {} : { disambiguation: "Multiple iframe elements match; scope by src or position." }),
    },
    fallback_locators: [],
    properties: emptyProperties({ is_visible: isVisible }),
    context_note: `Cross-origin iframe (${entry.url || "unknown URL"}): DOM is unreachable from this context and was NOT extracted. Tests can still interact via frameLocator('${selector.replace(/'/g, "\\'")}').`,
  };
}

/**
 * "Settled" wait for `wait_for: "auto"`: no xhr/fetch request in flight AND
 * no DOM mutation for `quietMs`, bounded by `maxMs`. Real SPAs render after
 * `load` once their data arrives, and never go network-idle when analytics
 * or polling run, so neither Playwright condition alone works as a default:
 * `networkidle` times out on pages with beacons, `load` snapshots an empty
 * application shell, and a DOM-quiet window alone resolves while the first
 * data request is still pending. A navigation during the wait (a redirect to
 * login) simply restarts the mutation counter on the new document.
 */
const SETTLE_QUIET_MS = 500;
const SETTLE_MAX_MS = 6_000;
const SETTLE_POLL_MS = 100;

export interface SettleTracker {
  /** Poll until settled (or maxMs), then detach. */
  wait(quietMs?: number, maxMs?: number): Promise<void>;
  /** Detach without waiting (navigation failed). */
  stop(): void;
}

/**
 * Attach BEFORE navigating: a SPA fires its first data request while the
 * document is still parsing, well before `load`, and a tracker attached
 * afterwards would count that request as never having been in flight.
 */
export function trackSettle(page: Page): SettleTracker {
  let inflight = 0;
  const isData = (r: import("playwright").Request) => r.resourceType() === "xhr" || r.resourceType() === "fetch";
  const onRequest = (r: import("playwright").Request) => {
    if (isData(r)) inflight++;
  };
  const onDone = (r: import("playwright").Request) => {
    if (isData(r)) inflight = Math.max(0, inflight - 1);
  };
  const onNavigated = (frame: import("playwright").Frame) => {
    if (frame === page.mainFrame()) inflight = 0; // requests of the old document are gone with it
  };
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);
  page.on("framenavigated", onNavigated);
  const stop = () => {
    page.off("request", onRequest);
    page.off("requestfinished", onDone);
    page.off("requestfailed", onDone);
    page.off("framenavigated", onNavigated);
  };
  return {
    stop,
    async wait(quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS) {
      try {
        await waitForSettled(page, () => inflight, quietMs, maxMs);
      } finally {
        stop();
      }
    },
  };
}

async function waitForSettled(page: Page, inflight: () => number, quietMs: number, maxMs: number): Promise<void> {
  const start = Date.now();

  const install = () =>
    page
      .evaluate(() => {
        const w = window as unknown as { __qaMutations?: number };
        if (w.__qaMutations === undefined) {
          w.__qaMutations = 0;
          new MutationObserver(() => {
            w.__qaMutations = (w.__qaMutations ?? 0) + 1;
          }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        }
      })
      .catch(() => undefined);
  const read = () => page.evaluate(() => (window as unknown as { __qaMutations?: number }).__qaMutations ?? -1).catch(() => -1);

  await install();
  let last = await read();
  let lastChange = Date.now();
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(SETTLE_POLL_MS);
    const count = await read();
    if (count === -1) {
      // Context gone (navigation): new document, start over on it.
      await install();
      lastChange = Date.now();
      last = await read();
      continue;
    }
    if (count !== last) {
      last = count;
      lastChange = Date.now();
    }
    if (inflight() === 0 && Date.now() - lastChange >= quietMs) return;
  }
}

/** `auto` (default): `load`, then waitForSettled. See there for why. */
export async function navigateForExtraction(
  page: Page,
  input: Pick<ExtractInput, "url" | "wait_for" | "wait_selector">,
): Promise<void> {
  const settle = input.wait_for === "auto" ? trackSettle(page) : null;
  try {
    await page.goto(input.url, { waitUntil: input.wait_for === "auto" ? "load" : input.wait_for, timeout: NAV_TIMEOUT_MS });
  } catch (err) {
    settle?.stop();
    throw new ExtractError(
      "navigation_failed",
      `Navigation to the target URL failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      input.wait_for === "networkidle"
        ? "Pages with analytics or polling never go network-idle; use wait_for:'auto' (the default) or wait_selector."
        : "Check that the staging URL is reachable and the wait_for condition is achievable.",
    );
  }
  if (settle) await settle.wait();
  if (input.wait_selector) {
    try {
      await page.waitForSelector(input.wait_selector, {
        state: "attached",
        timeout: WAIT_SELECTOR_TIMEOUT_MS,
      });
    } catch {
      throw new ExtractError(
        "wait_selector_timeout",
        `wait_selector '${input.wait_selector}' did not appear within ${WAIT_SELECTOR_TIMEOUT_MS / 1000}s.`,
        "Verify the selector, or extract without it to inspect what the page actually contains.",
      );
    }
  }
}

export type SnapshotOptions = Pick<
  ExtractInput,
  "include_hidden" | "max_nodes" | "include_click_targets" | "scope" | "roles" | "visible_only" | "max_output_chars" | "include_tables"
>;

/** Snapshots the page's CURRENT state into a SemanticExtract. */
export async function snapshotPage(page: Page, input: SnapshotOptions, extraNotes: string[] = []): Promise<SemanticExtract> {
    const frames = await enumerateFrames(page);
    const nodes: InteractiveNode[] = [];
    const notes: string[] = [...extraNotes];
    let truncated = false;
    let hiddenDropped = 0;
    let budget = input.max_nodes;

    for (const entry of frames) {
      if (!entry.reachable) {
        nodes.push(await crossOriginMarker(entry, notes));
        continue;
      }
      if (budget <= 0) {
        truncated = true;
        notes.push(`MAX_NODES (${input.max_nodes}) exhausted before frame '${entry.url}' was extracted.`);
        continue;
      }

      let raw: RawExtractResult;
      try {
        raw = (await withTimeout(
          entry.frame.evaluate(
            buildEvaluateExpression({
              maxNodes: budget,
              maxDepth: MAX_DEPTH,
              includeClickTargets: input.include_click_targets === true,
              ...(input.scope ? { scopeSelector: input.scope } : {}),
              ...(input.roles && input.roles.length > 0 ? { roles: input.roles } : {}),
              ...(input.visible_only ? { visibleOnly: true } : {}),
            }),
          ),
          EVALUATE_TIMEOUT_MS,
          "In-page extraction",
        )) as RawExtractResult;
      } catch (err) {
        if (err instanceof ExtractError) throw err;
        notes.push(
          `Frame '${entry.url}' could not be evaluated and was skipped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
        continue;
      }

      budget -= raw.nodes.length;
      truncated = truncated || raw.truncated;
      for (const n of raw.notes) {
        notes.push(entry.path.length === 0 ? n : `[frame ${entry.path.join(" > ")}] ${n}`);
      }

      const cache: CountCache = new Map();
      const kept = raw.nodes.filter((rawNode) => {
        if (!input.include_hidden && !rawNode.properties.is_visible) {
          hiddenDropped++;
          return false;
        }
        return true;
      });
      // Locator verification is I/O bound (one count() per candidate) — run
      // nodes in bounded parallel batches, preserving document order.
      const CONCURRENCY = 8;
      for (let i = 0; i < kept.length; i += CONCURRENCY) {
        const batch = kept.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((r) => resolveLocators(entry.frame, r, cache)));
        for (let j = 0; j < batch.length; j++) {
          const rawNode = batch[j]!;
          const { primary, fallbacks, note } = results[j]!;
          const node: InteractiveNode = {
            kind: rawNode.kind,
            tag: rawNode.tag,
            role: rawNode.role,
            in_shadow: rawNode.in_shadow,
            frame_path: entry.path,
            form_group: rawNode.form_group,
            accessible_name: rawNode.accessible_name,
            primary_locator: primary,
            fallback_locators: fallbacks,
            properties: rawNode.properties,
            identity: rawNode.identity,
          };
          const contextNotes = [rawNode.context_note, note].filter(Boolean);
          if (contextNotes.length > 0) node.context_note = contextNotes.join(" ");
          nodes.push(node);
        }
      }
    }

    if (hiddenDropped > 0) {
      notes.push(`${hiddenDropped} hidden node(s) excluded because include_hidden=false.`);
    }
    if (nodes.length === 0) {
      notes.push(
        "0 nodes extracted. If this page is a SPA that renders after the wait point, retry with wait_for:'auto' (default) or a wait_selector for a key element.",
      );
    }

    // Output budget: keep nodes in document order until the compact wire size
    // would exceed the budget; count the rest. Never silent.
    let kept = nodes;
    let omitted: SemanticExtract["omitted"];
    if (input.max_output_chars !== undefined && input.max_output_chars > 0) {
      // Facts before heuristics: opt-in click-target nodes are extras, so they
      // yield the budget to real interactive nodes. Within each group,
      // document order, and survivors are returned in document order.
      const isHeuristic = (n: InteractiveNode) => (n.context_note ?? "").includes("click-target heuristic");
      const ordered = [...nodes.filter((n) => !isHeuristic(n)), ...nodes.filter(isHeuristic)];
      const order = new Map(nodes.map((n, i) => [n, i]));
      let used = 600; // metadata envelope
      const within: InteractiveNode[] = [];
      const droppedRoles = new Map<string, number>();
      for (const node of ordered) {
        const size = JSON.stringify(compactNode(node)).length + 1;
        if (used + size <= input.max_output_chars) {
          used += size;
          within.push(node);
        } else {
          const key = node.role ?? node.tag;
          droppedRoles.set(key, (droppedRoles.get(key) ?? 0) + 1);
        }
      }
      if (within.length < nodes.length) {
        within.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
        const byRole = [...droppedRoles.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${r}`).join(", ");
        omitted = {
          nodes: nodes.length - within.length,
          reason: `max_output_chars (${input.max_output_chars}) reached. Dropped: ${byRole}. Narrow with roles/scope/visible_only, or raise the budget.`,
        };
        notes.push(`${nodes.length - within.length} node(s) omitted by max_output_chars; see 'omitted'.`);
        kept = within;
      }
    }

    let structured: Pick<SemanticExtract, "tables" | "dialogs"> = {};
    if (input.include_tables) {
      const outline = await outlinePage(page, input.scope);
      structured = { tables: outline.tables, dialogs: outline.dialogs };
    }

    const extract = redactDeep<SemanticExtract>({
      schema_version: "1.5",
      page_metadata: {
        title: await pageTitle(page),
        url: page.url(),
        captured_at: new Date().toISOString(),
        node_count: kept.length,
        frame_count: frames.length,
        truncated,
        notes,
      },
      interactive_nodes: kept,
      ...structured,
      ...(omitted ? { omitted } : {}),
    });
    // A locator whose text contained a secret cannot be used as emitted: say so
    // rather than carry a verified-unique flag on a string that matches nothing.
    for (const node of extract.interactive_nodes) {
      for (const loc of [node.primary_locator, ...node.fallback_locators]) {
        if (loc.playwright.includes(REDACTED)) {
          loc.is_unique = false;
          loc.disambiguation = "Locator text contained a redacted secret; locate this element by another attribute.";
        }
      }
    }
    return extract;
}

export async function extractSemanticDom(input: ExtractInput): Promise<SemanticExtract> {
  const denial = checkUrlAllowed(input.url);
  if (denial) throw new ExtractError("url_not_allowed", denial);
  return withPage(async (page) => {
    console.error(`[semantic-dom-mcp] extracting (wait_for=${input.wait_for})`);
    await navigateForExtraction(page, input);
    return snapshotPage(page, input);
  }, input.viewport);
}

/* ------------------------------------------------------------------ */
/* Outline (v0.8): the page as a map                                    */
/* ------------------------------------------------------------------ */

const OUTLINE_MAX_ROWS = 20;

/** Raw outline of the main frame (structured tables/dialogs included), redacted. */
export async function outlinePage(page: Page, scope?: string | undefined): Promise<RawOutline> {
  const raw = (await withTimeout(
    page.mainFrame().evaluate(buildOutlineExpression({ maxRows: OUTLINE_MAX_ROWS, ...(scope ? { scopeSelector: scope } : {}) })),
    EVALUATE_TIMEOUT_MS,
    "In-page outline",
  )) as RawOutline;
  return redactDeep(raw);
}

export async function outlineFromPage(page: Page, scope?: string | undefined, extraNotes: string[] = []): Promise<SemanticOutline> {
  const raw = await outlinePage(page, scope);
  return {
    schema_version: "1.5",
    kind: "outline",
    page_metadata: { title: await pageTitle(page), url: page.url(), captured_at: new Date().toISOString(), notes: [...extraNotes, ...raw.notes] },
    interactive_count: raw.interactive_count,
    regions: raw.regions,
    tables: raw.tables,
    dialogs: raw.dialogs,
    alerts: raw.alerts,
  };
}

export interface OutlineInput extends Pick<ExtractInput, "url" | "wait_for" | "wait_selector" | "viewport" | "scope"> {}

export async function extractOutline(input: OutlineInput): Promise<SemanticOutline> {
  const denial = checkUrlAllowed(input.url);
  if (denial) throw new ExtractError("url_not_allowed", denial);
  return withPage(async (page) => {
    console.error(`[semantic-dom-mcp] outline (wait_for=${input.wait_for})`);
    await navigateForExtraction(page, input);
    return outlineFromPage(page, input.scope);
  }, input.viewport);
}

/* ------------------------------------------------------------------ */
/* verify_locators (v0.8): close the loop after the test is written     */
/* ------------------------------------------------------------------ */

export interface LocatorVerdict {
  playwright: string;
  matches: number | null;
  unique: boolean;
  /** Parse or evaluation problem; the expression cannot be used as written. */
  error?: string;
  /** First match, for a sanity check of what the expression points at. */
  first?: { tag: string; role: string | null; name: string | null; visible: boolean };
}

export async function verifyLocatorsOnPage(page: Page, expressions: string[]): Promise<LocatorVerdict[]> {
  const out: LocatorVerdict[] = [];
  for (const expr of expressions) {
    let parsed: ActionLocator;
    try {
      parsed = parseLocatorExpression(expr);
    } catch (err) {
      out.push({ playwright: expr, matches: null, unique: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    try {
      const target = actionTarget(page, parsed);
      const matches = await target.count();
      const verdict: LocatorVerdict = { playwright: expr, matches, unique: matches === 1 };
      if (matches > 0) {
        verdict.first = await target.first().evaluate((el) => ({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          name: el.getAttribute("aria-label") || (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80) || null,
          visible: !!(el as HTMLElement).offsetParent || getComputedStyle(el).position === "fixed",
        }));
      }
      out.push(verdict);
    } catch (err) {
      out.push({ playwright: expr, matches: null, unique: false, error: err instanceof Error ? err.message.split("\n")[0]! : String(err) });
    }
  }
  return out;
}

export interface VerifyInput extends Pick<ExtractInput, "url" | "wait_for" | "wait_selector" | "viewport"> {
  locators: string[];
}

export async function verifyLocators(input: VerifyInput): Promise<{ url: string; results: LocatorVerdict[]; summary: { total: number; unique: number; ambiguous: number; missing: number; invalid: number } }> {
  const denial = checkUrlAllowed(input.url);
  if (denial) throw new ExtractError("url_not_allowed", denial);
  return withPage(async (page) => {
    await navigateForExtraction(page, input);
    const results = await verifyLocatorsOnPage(page, input.locators);
    return { url: page.url(), results, summary: summarizeVerdicts(results) };
  }, input.viewport);
}

export function summarizeVerdicts(results: LocatorVerdict[]) {
  return {
    total: results.length,
    unique: results.filter((r) => r.unique).length,
    ambiguous: results.filter((r) => r.matches !== null && r.matches > 1).length,
    missing: results.filter((r) => r.matches === 0).length,
    invalid: results.filter((r) => r.error !== undefined).length,
  };
}

/* ------------------------------------------------------------------ */
/* Declared-actions extraction ("multi-snapshot", v0.2)                */
/* ------------------------------------------------------------------ */

export interface ActionLocator {
  /** A `playwright` expression exactly as an extraction returned it; parsed by a strict grammar. Alternative to strategy/value. */
  playwright?: string | undefined;
  strategy: LocatorStrategy;
  value: string;
  role?: string;
  /** Apply .nth(i) — use the index from a prior extraction's disambiguation. */
  nth?: number;
  /** Scope to a container first, as given by the extraction's `within`. */
  within?: { kind: "row" | "listitem" | "test-id" | "css"; value: string } | undefined;
}

export type PageAction =
  | { type: "fill"; locator: ActionLocator; value: string; secret?: boolean | undefined }
  | { type: "click"; locator: ActionLocator }
  | { type: "press"; locator: ActionLocator; key: string }
  | { type: "select"; locator: ActionLocator; value: string }
  | { type: "goto"; url: string }
  | { type: "wait"; ms: number };

export interface ExtractAfterActionsInput extends ExtractInput {
  actions: PageAction[];
  settle_ms: number;
  /** Wait for this selector to be visible AFTER the actions, before the
   * snapshot — deterministic alternative to guessing settle_ms for
   * late-rendering toasts/modals. */
  wait_selector_after?: string | undefined;
}

const ACTION_TIMEOUT_MS = 10_000;

/** The page's current host checked against the allowlist; null when fine. Pure — callers own their error. */
export function allowlistDenial(page: Page): string | null {
  return checkUrlAllowed(page.url());
}

/** After actions ran, the page must still be on an allowlisted host — else nothing is extracted. */
export function assertStillAllowlisted(page: Page): void {
  const postDenial = allowlistDenial(page);
  if (postDenial) {
    throw new ExtractError(
      "navigated_off_allowlist",
      `After the actions ran the page is at '${stripQuery(page.url())}', which is not allowlisted: ${postDenial}`,
      "The declared actions triggered a navigation outside QA_MCP_ALLOWED_HOSTS; nothing was extracted.",
    );
  }
}

/** Waits for `wait_selector_after` (visible) with a structured timeout error. */
export async function waitAfterActions(page: Page, selector: string | undefined, settleMs: number): Promise<void> {
  if (selector) {
    try {
      await page.waitForSelector(selector, { state: "visible", timeout: WAIT_SELECTOR_TIMEOUT_MS });
    } catch {
      throw new ExtractError(
        "wait_selector_after_timeout",
        `wait_selector_after '${selector}' did not become visible within ${WAIT_SELECTOR_TIMEOUT_MS / 1000}s after the actions.`,
        "Verify the selector and that the declared actions actually trigger that UI; or extract without it to inspect the resulting state.",
      );
    }
  }
  if (settleMs > 0) await page.waitForTimeout(settleMs);
}

function actionTarget(page: Page, raw: ActionLocator) {
  const loc = raw.playwright ? { ...parseLocatorExpression(raw.playwright), ...(raw.nth !== undefined ? { nth: raw.nth } : {}) } : raw;
  let target = buildPwLocator(page.mainFrame(), {
    strategy: loc.strategy,
    value: loc.value,
    ...(loc.role !== undefined ? { role: loc.role } : {}),
    ...(loc.within ? { within: loc.within } : {}),
  });
  if (loc.nth !== undefined) target = target.nth(loc.nth);
  return target;
}

export async function performAction(page: Page, action: PageAction, index: number): Promise<void> {
  try {
    switch (action.type) {
      case "wait":
        await page.waitForTimeout(action.ms);
        return;
      case "fill": {
        const target = actionTarget(page, action.locator);
        await target.fill(action.value, { timeout: ACTION_TIMEOUT_MS });
        // Values typed into password fields (or flagged secret) are scrubbed
        // from every output string from now on. Detected after the fill, on
        // the element that just received it, so a missing target does not
        // wait twice; nothing is output between the two steps.
        const isPassword = action.secret
          ? true
          : await target.evaluate((el) => (el as HTMLInputElement).type === "password", undefined, { timeout: 1_000 }).catch(() => false);
        if (isPassword) registerSecret(action.value);
        return;
      }
      case "click":
        await actionTarget(page, action.locator).click({ timeout: ACTION_TIMEOUT_MS });
        return;
      case "press":
        await actionTarget(page, action.locator).press(action.key, { timeout: ACTION_TIMEOUT_MS });
        return;
      case "select":
        await actionTarget(page, action.locator).selectOption(action.value, { timeout: ACTION_TIMEOUT_MS });
        return;
      case "goto": {
        // In-flow navigation (checkout after cart) — allowlisted like any URL.
        const denial = checkUrlAllowed(action.url);
        if (denial) {
          throw new ExtractError(
            "url_not_allowed",
            `Action ${index + 1} (goto): ${denial}`,
            /^Not a valid URL/.test(denial)
              ? "goto needs an absolute http(s) URL; build it from observed.navigations or the page URL."
              : undefined,
          );
        }
        const settle = trackSettle(page);
        await page.goto(action.url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch((err) => {
          settle.stop();
          throw err;
        });
        await settle.wait();
        return;
      }
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    if (err instanceof LocatorParseError) {
      throw new ExtractError("invalid_locator", `Action ${index + 1} (${action.type}): ${err.message}`, "Paste a `playwright` expression exactly as an extraction returned it, or use strategy/value.");
    }
    // Never echo fill values (they may hold credentials) — only the locator.
    const reason = actionFailureReason(err);
    const where =
      action.type === "wait"
        ? "wait"
        : action.type === "goto"
          ? `url='${stripQuery(action.url)}'`
          : action.locator.playwright
            ? action.locator.playwright
            : `${action.locator.strategy}='${action.locator.value}'`;
    throw new ExtractError(
      "action_failed",
      `Action ${index + 1} (${action.type}) failed on ${where}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}${reason ? ` Reason: ${reason}` : ""}`,
      "Derive action locators from a prior extract_semantic_dom call; apply nth from its disambiguation when flagged non-unique.",
    );
  }
}

/**
 * Playwright puts the useful part of an action failure in its call log
 * ("<div> intercepts pointer events", "element is not visible", "strict mode
 * violation … resolved to 3 elements"); the first line is just the timeout.
 */
function actionFailureReason(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const lines = err.message.split("\n").map((l) => l.replace(/^\s*-\s*/, "").replace(/^\d+ × /, "").trim());
  // Actionability verdicts first; "waiting for <locator>" only says the element never showed up.
  const verdict = /intercepts pointer events|is not visible|not enabled|not editable|outside of the viewport|strict mode violation|resolved to \d+ elements|element is not attached|element was detached|is hidden/i;
  const picked: string[] = [];
  for (const l of lines) {
    if (verdict.test(l) && !picked.includes(l)) picked.push(l);
    if (picked.length === 3) break;
  }
  if (picked.length === 0) {
    const waiting = lines.find((l) => /^waiting for/i.test(l));
    if (waiting) picked.push(`${waiting} (no element matched within the timeout)`);
  }
  return picked.length > 0 ? picked.join("; ") : null;
}

/**
 * Navigates, performs a short DECLARED action list in the main frame, then
 * snapshots the resulting state — for post-interaction UI such as success
 * toasts, validation errors, and opened dialogs.
 *
 * This is the single sanctioned exception to "the extractor never mutates
 * the page", with its own guardrails:
 * allowlisted action types only, bounded counts and timeouts, values never
 * logged, and the page must still be on an allowlisted host after the
 * actions ran — otherwise nothing is extracted.
 */
export async function extractAfterActions(input: ExtractAfterActionsInput): Promise<SemanticExtract> {
  const denial = checkUrlAllowed(input.url);
  if (denial) throw new ExtractError("url_not_allowed", denial);
  return withPage(async (page) => {
    console.error(
      `[semantic-dom-mcp] extracting after ${input.actions.length} declared action(s) (wait_for=${input.wait_for})`,
    );
    await navigateForExtraction(page, input);
    const observer = observePage(page);
    const mark = observer.mark();
    try {
      for (let i = 0; i < input.actions.length; i++) {
        await performAction(page, input.actions[i]!, i);
        assertStillAllowlisted(page); // never run the next action on a foreign host
      }
      await waitAfterActions(page, input.wait_selector_after, input.settle_ms);
      assertStillAllowlisted(page);
      const observed = redactDeep(observer.since(mark));
      const extract = await snapshotPage(page, input, [
        `State captured AFTER ${input.actions.length} declared action(s); this is still a single snapshot of that post-interaction moment. Transient UI may expire before locator verification (such locators report 0 matches).`,
      ]);
      return { ...extract, observed };
    } finally {
      observer.stop();
    }
  }, input.viewport);
}

/* ------------------------------------------------------------------ */
/* check_auth diagnostic                                                */
/* ------------------------------------------------------------------ */

export interface AuthCheckReport {
  storage_state: "set" | "not_set";
  /** Present when the storageState file is readable by other users. */
  storage_state_warning?: string;
  requested_url: string;
  final_url: string;
  redirected: boolean;
  /** Final path matches a login-ish pattern — the session likely expired. */
  looks_logged_out: boolean;
}

export async function checkAuth(url: string, waitFor: WaitFor): Promise<AuthCheckReport> {
  const denial = checkUrlAllowed(url);
  if (denial) throw new ExtractError("url_not_allowed", denial);
  return withPage(async (page) => {
    await navigateForExtraction(page, { url, wait_for: waitFor });
    const finalUrl = page.url();
    let path = "";
    try {
      path = new URL(finalUrl).pathname;
    } catch {
      path = finalUrl;
    }
    const ss = process.env.QA_MCP_STORAGE_STATE;
    const permissionProblem = ss ? storageStatePermissionProblem(ss) : null;
    return {
      storage_state: ss ? "set" : "not_set",
      ...(permissionProblem ? { storage_state_warning: permissionProblem } : {}),
      requested_url: url,
      final_url: finalUrl,
      redirected: finalUrl.replace(/\/$/, "") !== url.replace(/\/$/, ""),
      looks_logged_out: /login|log-in|signin|sign-in|masuk|auth/i.test(path),
    };
  });
}

/* ------------------------------------------------------------------ */
/* list_frames diagnostic                                              */
/* ------------------------------------------------------------------ */

export interface FrameReport {
  frame_path: string[];
  url: string;
  name: string;
  same_origin: boolean;
  reachable: boolean;
}

export async function listFrames(url: string, waitFor: WaitFor): Promise<FrameReport[]> {
  const denial = checkUrlAllowed(url);
  if (denial) throw new ExtractError("url_not_allowed", denial);

  return withPage(async (page) => {
    try {
      const settle = waitFor === "auto" ? trackSettle(page) : null;
      await page.goto(url, { waitUntil: waitFor === "auto" ? "load" : waitFor, timeout: NAV_TIMEOUT_MS }).catch((err) => {
        settle?.stop();
        throw err;
      });
      if (settle) await settle.wait();
    } catch (err) {
      throw new ExtractError(
        "navigation_failed",
        `Navigation to the target URL failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
    const frames = await enumerateFrames(page);
    return frames.map((f) => ({
      frame_path: f.path,
      url: f.url,
      name: f.name,
      same_origin: f.sameOrigin,
      reachable: f.reachable,
    }));
  });
}
