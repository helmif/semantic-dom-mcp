/**
 * Behavior observer: records what the page DID while declared actions ran.
 *
 * Tests need this knowledge as much as they need locators — the redirect
 * target after login, the API call to await before asserting a toast, the
 * console error that explains a blank screen. The previous A/B run's only
 * remaining iterations were exactly these facts, guessed by the engineer.
 *
 * Observation only. The server never issues requests; it listens to the ones
 * the page makes. Privacy discipline: request/response bodies are never read,
 * query strings are stripped from URLs (they may carry tokens), console text
 * is capped, and dialog messages are the page's own UI copy.
 *
 * Model: one append-only recording per page. Callers take a `mark()` and
 * later read `since(mark)`; a session `compact()`s once a snapshot has
 * consumed the recording. Everything is recorded synchronously at event time
 * so a slice taken right after an action is complete.
 */
import type { ConsoleMessage, Dialog, Frame, Page, Request, Response } from "playwright";
import { __qaCollapse } from "./extractor/traverse.js";
import type { Observed, ObservedRequest } from "./types.js";
import { stripQuery } from "./url.js";

/** Caps apply per recording segment (between session snapshots, or per after-tool call). */
export const MAX_REQUESTS = 500;
const MAX_CONSOLE = 50;
const MAX_TEXT = 200;
/** Only what a test would wait on. Images, fonts, scripts, styles are noise. */
const KEPT_RESOURCE_TYPES = new Set(["xhr", "fetch", "document", "eventsource", "websocket"]);

function cap(text: string): string {
  const t = __qaCollapse(text);
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) : t;
}

/** Position in the recording; see Observer.mark/since. */
export interface ObserverMark {
  nav: number;
  req: number;
  con: number;
  dlg: number;
  pop: number;
  droppedReq: number;
  droppedCon: number;
  at: number;
}

export interface Observer {
  /** Remember the current position so `since` can slice from it. */
  mark(): ObserverMark;
  /** Everything recorded after `mark`. Entries are copied; the recording is untouched. */
  since(mark: ObserverMark): Observed;
  /** Forget everything recorded so far (marks taken before this are invalid). */
  compact(): void;
  /** Detach listeners. */
  stop(): void;
}

export function observePage(page: Page): Observer {
  const startedAt = Date.now();
  let navigations: Observed["navigations"] = [];
  let requests: ObservedRequest[] = [];
  let consoleErrors: Observed["console_errors"] = [];
  let dialogs: Observed["dialogs"] = [];
  let popups: Observed["popups"] = [];
  let droppedRequests = 0;
  let droppedConsole = 0;
  let lastUrl = page.url();
  // Response/failure events find their entry through the Request object; a
  // WeakMap holds nothing alive once Playwright drops the request.
  const byRequest = new WeakMap<Request, ObservedRequest>();

  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const to = frame.url();
    if (to === lastUrl) return;
    navigations.push({ from: lastUrl, to, at_ms: Date.now() - startedAt });
    lastUrl = to;
  };

  const onRequest = (req: Request) => {
    const type = req.resourceType();
    if (!KEPT_RESOURCE_TYPES.has(type) || req.url().startsWith("data:") || requests.length >= MAX_REQUESTS) {
      droppedRequests++;
      return;
    }
    const entry: ObservedRequest = { method: req.method(), url: stripQuery(req.url()), status: null, resource_type: type };
    byRequest.set(req, entry);
    requests.push(entry);
  };

  const onResponse = (res: Response) => {
    const entry = byRequest.get(res.request());
    if (entry) entry.status = res.status();
  };

  const onRequestFailed = (req: Request) => {
    const entry = byRequest.get(req);
    // A response already arrived: the HTTP exchange succeeded and only the
    // body read was cut short (a navigation aborting a fetch). Not a failure.
    if (entry && entry.status === null) entry.failed = req.failure()?.errorText ?? "failed";
  };

  const pushConsole = (level: "error" | "warning", text: string) => {
    if (consoleErrors.length >= MAX_CONSOLE) {
      droppedConsole++;
      return;
    }
    consoleErrors.push({ level, text: cap(text) });
  };
  const onConsole = (msg: ConsoleMessage) => {
    const type = msg.type();
    if (type === "error" || type === "warning") pushConsole(type, msg.text());
  };
  const onPageError = (err: Error) => pushConsole("error", `Uncaught: ${err.message}`);

  const onDialog = (dialog: Dialog) => {
    dialogs.push({ type: dialog.type(), message: cap(dialog.message()), handled: "dismissed" });
    dialog.dismiss().catch(() => undefined);
  };

  // Playwright fires `popup` once the new window has committed its initial
  // navigation, so the URL is known here. Record it synchronously and close
  // the window at once: a flow never continues in a page this server did not
  // open, and nothing further is loaded into it.
  const onPopup = (popup: Page) => {
    popups.push({ url: stripQuery(popup.url()), handled: "closed" });
    popup.close().catch(() => undefined);
  };

  page.on("framenavigated", onFrameNavigated);
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("dialog", onDialog);
  page.on("popup", onPopup);

  return {
    mark(): ObserverMark {
      return {
        nav: navigations.length,
        req: requests.length,
        con: consoleErrors.length,
        dlg: dialogs.length,
        pop: popups.length,
        droppedReq: droppedRequests,
        droppedCon: droppedConsole,
        at: Date.now(),
      };
    },
    since(m: ObserverMark): Observed {
      const offset = m.at - startedAt;
      return {
        duration_ms: Date.now() - m.at,
        navigations: navigations.slice(m.nav).map((n) => ({ ...n, at_ms: Math.max(0, n.at_ms - offset) })),
        requests: requests.slice(m.req).map((r) => ({ ...r })),
        console_errors: consoleErrors.slice(m.con),
        dialogs: dialogs.slice(m.dlg),
        popups: popups.slice(m.pop),
        dropped: { requests: droppedRequests - m.droppedReq, console_errors: droppedConsole - m.droppedCon },
      };
    },
    compact() {
      navigations = [];
      requests = [];
      consoleErrors = [];
      dialogs = [];
      popups = [];
      droppedRequests = 0;
      droppedConsole = 0;
    },
    stop() {
      page.off("framenavigated", onFrameNavigated);
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("dialog", onDialog);
      page.off("popup", onPopup);
    },
  };
}
