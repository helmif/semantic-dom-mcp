/**
 * Persistent sessions: one live page that survives across tool calls, so an
 * agent can walk a whole flow (login → cart → checkout), act at each step,
 * and snapshot or diff without replaying from a cold start every time.
 *
 * Guardrails mirror the single-shot tools — the allowlist is checked before
 * any action runs, after every action, and before every snapshot (a session
 * found off the allowlisted hosts is closed, never acted on or extracted),
 * only declared action types run, fill values are never logged — plus
 * session-specific ones: an idle TTL, a hard cap on open sessions, one
 * in-flight call per session, and a bounded snapshot history.
 */
import { randomBytes } from "node:crypto";
import type { BrowserContext, Page } from "playwright";
import {
  allowlistDenial,
  checkUrlAllowed,
  ExtractError,
  getBrowser,
  navigateForExtraction,
  newContext,
  performAction,
  snapshotPage,
  waitAfterActions,
  type ExtractInput,
  type PageAction,
  type ViewportPreset,
} from "./browser.js";
import { diffExtracts } from "./diff.js";
import { observePage, type Observer, type ObserverMark } from "./observe.js";
import { redactDeep } from "./secrets.js";
import type { Observed, SemanticDiff, SemanticExtract } from "./types.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Idle time after which a session is reaped (env QA_MCP_SESSION_TTL_MS). */
export function sessionTtlMs(): number {
  return envInt("QA_MCP_SESSION_TTL_MS", 10 * 60_000);
}
/** Max concurrently open sessions (env QA_MCP_MAX_SESSIONS). */
export function maxSessions(): number {
  return envInt("QA_MCP_MAX_SESSIONS", 3);
}
export const MAX_SNAPSHOTS_KEPT = 5;
const REAP_INTERVAL_MS = 30_000;

interface Session {
  id: string;
  context: BrowserContext;
  page: Page;
  observer: Observer;
  /** Recording position of the last snapshot; a snapshot's `observed` starts here. */
  baseline: ObserverMark;
  viewport: ViewportPreset;
  title: string;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
  actionsPerformed: number;
  snapshotsTaken: number;
  /** Last MAX_SNAPSHOTS_KEPT snapshots, stored without `observed` (the diff reads it from the newer side). */
  snapshots: Map<number, SemanticExtract>;
}

const sessions = new Map<string, Session>();
/** Sessions being opened (context not yet created) — counted against the cap. */
let opening = 0;
let reaper: NodeJS.Timeout | undefined;

/* ------------------------------------------------------------------ */
/* Lifecycle primitives                                                 */
/* ------------------------------------------------------------------ */

function isDead(s: Session): boolean {
  if (s.page.isClosed()) return true;
  return !s.busy && Date.now() - s.lastUsedAt > sessionTtlMs();
}

async function destroy(s: Session): Promise<void> {
  sessions.delete(s.id);
  try {
    s.observer.stop();
  } catch {
    // listeners already gone
  }
  await s.context.close().catch(() => undefined);
}

/** One sweep for the timer, for lookups, and for opens: closes dead sessions in parallel. */
async function sweep(): Promise<void> {
  const dead = [...sessions.values()].filter(isDead);
  if (dead.length === 0) return;
  for (const s of dead) console.error(`[semantic-dom-mcp] session ${s.id} closed (${s.page.isClosed() ? "page gone" : "idle TTL"})`);
  await Promise.all(dead.map(destroy));
}

function ensureReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => void sweep(), REAP_INTERVAL_MS);
  reaper.unref();
}

function expiresAt(s: Session): string {
  return new Date(s.lastUsedAt + sessionTtlMs()).toISOString();
}

async function lookup(sessionId: string): Promise<Session> {
  await sweep();
  const s = sessions.get(sessionId);
  if (!s) {
    throw new ExtractError(
      "session_not_found",
      `No open session '${sessionId}'. It may have expired (idle TTL ${Math.round(sessionTtlMs() / 1000)}s), been closed, or left the allowlist.`,
      "Call session_open again; session_list shows what is open.",
    );
  }
  return s;
}

/** Holds the session's single in-flight slot while `fn` runs. A concurrent call is refused, not queued. */
async function locked<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  if (s.busy) {
    throw new ExtractError("session_busy", `Session '${s.id}' has a call in flight.`, "Wait for it to finish, then retry.");
  }
  s.busy = true;
  try {
    return await fn();
  } finally {
    s.busy = false;
    s.lastUsedAt = Date.now();
  }
}

/** Off-allowlist pages are never acted on or extracted; a session there is closed. */
async function guardAllowlist(s: Session, when: string): Promise<void> {
  const denial = allowlistDenial(s.page);
  if (!denial) return;
  await destroy(s);
  throw new ExtractError(
    "navigated_off_allowlist",
    `Session '${s.id}' is at '${s.page.url()}' ${when}, which is not allowlisted: ${denial} The session has been closed.`,
    "The flow left QA_MCP_ALLOWED_HOSTS. Add the host if it is yours, or stop the flow before that step; then session_open again.",
  );
}

/* ------------------------------------------------------------------ */
/* session_open                                                          */
/* ------------------------------------------------------------------ */

export interface SessionOpenInput {
  url: string;
  wait_for: ExtractInput["wait_for"];
  wait_selector?: string | undefined;
  viewport?: ViewportPreset | undefined;
}

export interface SessionInfo {
  session_id: string;
  url: string;
  title: string;
  viewport: ViewportPreset;
  opened_at: string;
  expires_at: string;
  actions_performed: number;
  snapshots_taken: number;
}

function info(s: Session): SessionInfo {
  return {
    session_id: s.id,
    url: s.page.url(),
    title: s.title,
    viewport: s.viewport,
    opened_at: new Date(s.createdAt).toISOString(),
    expires_at: expiresAt(s),
    actions_performed: s.actionsPerformed,
    snapshots_taken: s.snapshotsTaken,
  };
}

export async function openSession(input: SessionOpenInput): Promise<SessionInfo & { open_sessions: number; max_sessions: number }> {
  const denial = checkUrlAllowed(input.url);
  if (denial) throw new ExtractError("url_not_allowed", denial);

  await sweep();
  // The slot is reserved synchronously, before any await, so concurrent opens
  // cannot both pass the cap check.
  if (sessions.size + opening >= maxSessions()) {
    throw new ExtractError(
      "session_limit",
      `${sessions.size + opening} session(s) already open (max ${maxSessions()}).`,
      "Close one with session_close (or raise QA_MCP_MAX_SESSIONS).",
    );
  }
  opening++;
  let s: Session | undefined;
  try {
    const browser = await getBrowser();
    const viewport = input.viewport ?? "desktop";
    const context = await newContext(browser, viewport);
    const page = await context.newPage();
    const observer = observePage(page);
    s = {
      id: `s_${randomBytes(6).toString("hex")}`,
      context,
      page,
      observer,
      baseline: observer.mark(),
      viewport,
      title: "",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: true,
      actionsPerformed: 0,
      snapshotsTaken: 0,
      snapshots: new Map(),
    };
    sessions.set(s.id, s);
  } finally {
    opening--;
  }
  ensureReaper();
  const session = s;
  try {
    console.error(`[semantic-dom-mcp] session ${session.id} open (wait_for=${input.wait_for})`);
    await navigateForExtraction(session.page, input);
    await guardAllowlist(session, "after the opening navigation");
    session.title = await session.page.title();
    // The opening navigation is not part of any act.
    session.observer.compact();
    session.baseline = session.observer.mark();
    return { ...info(session), open_sessions: sessions.size, max_sessions: maxSessions() };
  } catch (err) {
    await destroy(session);
    throw err;
  } finally {
    session.busy = false;
    session.lastUsedAt = Date.now();
  }
}

/* ------------------------------------------------------------------ */
/* session_act                                                           */
/* ------------------------------------------------------------------ */

export interface SessionActInput {
  session_id: string;
  actions: PageAction[];
  settle_ms: number;
  wait_selector_after?: string | undefined;
}

export interface SessionActReport {
  session_id: string;
  url: string;
  title: string;
  actions_performed: number;
  /** What the page did while THESE actions ran. */
  observed: Observed;
  expires_at: string;
}

export async function actInSession(input: SessionActInput): Promise<SessionActReport> {
  const s = await lookup(input.session_id);
  return locked(s, async () => {
    // Never act on a page that drifted off the allowlist between calls.
    await guardAllowlist(s, "before the actions");
    console.error(`[semantic-dom-mcp] session ${s.id}: ${input.actions.length} declared action(s)`);
    const mark = s.observer.mark();
    try {
      for (let i = 0; i < input.actions.length; i++) {
        await performAction(s.page, input.actions[i]!, i);
        s.actionsPerformed++;
        await guardAllowlist(s, `after action ${i + 1}`);
      }
      await waitAfterActions(s.page, input.wait_selector_after, input.settle_ms);
    } catch (err) {
      // A failed step must not strand the session on a foreign host: the
      // allowlist verdict outranks the step's own error.
      await guardAllowlist(s, "after a failed action");
      throw err;
    }
    await guardAllowlist(s, "after the actions");
    s.title = await s.page.title();
    return redactDeep({
      session_id: s.id,
      url: s.page.url(),
      title: s.title,
      actions_performed: input.actions.length,
      observed: s.observer.since(mark),
      expires_at: expiresAt(s),
    });
  });
}

/* ------------------------------------------------------------------ */
/* session_extract                                                       */
/* ------------------------------------------------------------------ */

export interface SessionExtractInput extends Pick<ExtractInput, "include_hidden" | "max_nodes" | "include_click_targets"> {
  session_id: string;
  /** Snapshot id to diff against (from a prior session_extract), or "previous". */
  diff_against?: number | "previous" | undefined;
}

export async function extractInSession(input: SessionExtractInput): Promise<SemanticExtract | SemanticDiff> {
  const s = await lookup(input.session_id);
  return locked(s, async () => {
    await guardAllowlist(s, "before the snapshot");
    // Resolve the diff target first: a bad id must not consume a snapshot.
    const nextId = s.snapshotsTaken + 1;
    let fromId: number | undefined;
    if (input.diff_against !== undefined) {
      fromId = input.diff_against === "previous" ? nextId - 1 : input.diff_against;
      if (!s.snapshots.has(fromId)) {
        throw new ExtractError(
          "snapshot_not_found",
          fromId < 1
            ? `No previous snapshot in session '${s.id}' yet; take one with session_extract (no diff_against) first.`
            : `Snapshot #${fromId} is not available in session '${s.id}' (the last ${MAX_SNAPSHOTS_KEPT} are kept; next is #${nextId}).`,
          "Omit diff_against for a full extraction, or diff against a more recent snapshot id.",
        );
      }
    }

    // Snapshot first; only a successful snapshot consumes the recording and an id.
    const body = await snapshotPage(s.page, input, [
      `Session snapshot #${nextId} of '${s.id}' after ${s.actionsPerformed} action(s) in this session; a single moment of the live page.`,
    ]);
    const observed = redactDeep(s.observer.since(s.baseline));
    s.observer.compact();
    s.baseline = s.observer.mark();
    s.snapshotsTaken = nextId;
    s.title = body.page_metadata.title;

    const extract: SemanticExtract = { ...body, snapshot_id: nextId, observed };
    s.snapshots.set(nextId, { ...body, snapshot_id: nextId });
    if (s.snapshots.size > MAX_SNAPSHOTS_KEPT) s.snapshots.delete(s.snapshots.keys().next().value!);

    if (fromId === undefined) return extract;
    return diffExtracts(s.snapshots.get(fromId)!, extract);
  });
}

/* ------------------------------------------------------------------ */
/* session_close / session_list / shutdown                               */
/* ------------------------------------------------------------------ */

export interface SessionCloseReport {
  session_id: string;
  closed: true;
  /** false when the id was already gone (expired, closed, or never existed) — closing is idempotent. */
  was_open: boolean;
  actions_performed: number;
  snapshots_taken: number;
  lifetime_ms: number;
}

export async function closeSession(sessionId: string): Promise<SessionCloseReport> {
  await sweep();
  const s = sessions.get(sessionId);
  if (!s) return { session_id: sessionId, closed: true, was_open: false, actions_performed: 0, snapshots_taken: 0, lifetime_ms: 0 };
  if (s.busy) {
    throw new ExtractError("session_busy", `Session '${s.id}' has a call in flight.`, "Wait for it to finish, then close.");
  }
  const report: SessionCloseReport = {
    session_id: s.id,
    closed: true,
    was_open: true,
    actions_performed: s.actionsPerformed,
    snapshots_taken: s.snapshotsTaken,
    lifetime_ms: Date.now() - s.createdAt,
  };
  await destroy(s);
  console.error(`[semantic-dom-mcp] session ${s.id} closed`);
  return report;
}

export async function listSessions(): Promise<{ open_sessions: SessionInfo[]; max_sessions: number; ttl_ms: number }> {
  await sweep();
  return { open_sessions: [...sessions.values()].map(info), max_sessions: maxSessions(), ttl_ms: sessionTtlMs() };
}

export async function closeAllSessions(): Promise<void> {
  if (reaper) {
    clearInterval(reaper);
    reaper = undefined;
  }
  await Promise.all([...sessions.values()].map((s) => destroy(s)));
}

/** Test hook: number of open sessions. */
export function openSessionCount(): number {
  return sessions.size;
}
