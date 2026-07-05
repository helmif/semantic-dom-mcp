/**
 * Playwright-native locator derivation + uniqueness.
 *
 * Candidates arrive from the in-page engine as (strategy, value) data. Here
 * we build ready-to-paste `getBy*` expressions and count matches with
 * Playwright's OWN selector engine (`locator.count()` on the node's frame),
 * so `is_unique` reflects exactly what the emitted expression will match —
 * including open-shadow piercing and Playwright's accessible-name algorithm.
 * A non-unique primary is returned WITH disambiguation guidance, never
 * dropped or left unflagged.
 */
import type { Frame, Locator as PwLocator } from "playwright";
import type { Locator } from "../types.js";
import type { RawNode, RawLocatorCandidate } from "./traverse.js";

/** Single-quoted JS string literal, matching team style: getByTestId('...'). */
function q(value: string): string {
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** `#id` when the id is a simple identifier, attribute form otherwise. */
function idSelector(id: string): string {
  return /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/"/g, '\\"')}"]`;
}

export function buildExpression(c: RawLocatorCandidate): string {
  switch (c.strategy) {
    case "test-id":
      return `getByTestId(${q(c.value)})`;
    case "role":
      return c.value === ""
        ? `getByRole(${q(c.role ?? "")})`
        : `getByRole(${q(c.role ?? "")}, { name: ${q(c.value)} })`;
    case "label":
      return `getByLabel(${q(c.value)})`;
    case "placeholder":
      return `getByPlaceholder(${q(c.value)})`;
    case "text":
      return `getByText(${q(c.value)})`;
    case "id":
      return `locator(${q(idSelector(c.value))})`;
    case "css":
      return `locator(${q(c.value)})`;
  }
}

export function buildPwLocator(frame: Frame, c: RawLocatorCandidate): PwLocator {
  switch (c.strategy) {
    case "test-id":
      return frame.getByTestId(c.value);
    case "role":
      // The page may carry any role string; Playwright types restrict to known
      // ARIA roles. Unknown roles throw at count() time and are handled there.
      return c.value === ""
        ? frame.getByRole((c.role ?? "") as Parameters<Frame["getByRole"]>[0])
        : frame.getByRole((c.role ?? "") as Parameters<Frame["getByRole"]>[0], { name: c.value });
    case "label":
      return frame.getByLabel(c.value);
    case "placeholder":
      return frame.getByPlaceholder(c.value);
    case "text":
      return frame.getByText(c.value);
    case "id":
      return frame.locator(idSelector(c.value));
    case "css":
      return frame.locator(c.value);
  }
}

/** Match-count cache per frame — identical candidates repeat across nodes. */
export type CountCache = Map<string, number>;

async function countMatches(frame: Frame, c: RawLocatorCandidate, cache: CountCache): Promise<number | null> {
  const key = `${c.strategy}|${c.role ?? ""}|${c.value}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let count: number | null;
  try {
    count = await buildPwLocator(frame, c).count();
  } catch {
    count = null; // unresolvable candidate (e.g. invalid role/selector text)
  }
  if (count !== null) cache.set(key, count);
  return count;
}

/** Index of this node among the primary locator's matches, for `.nth(i)`. */
async function findNthIndex(frame: Frame, c: RawLocatorCandidate, cssPath: string): Promise<number | null> {
  if (!cssPath) return null;
  try {
    const idx = await buildPwLocator(frame, c).evaluateAll((els, path) => {
      const target = document.querySelector(path as string);
      return target ? (els as Element[]).indexOf(target) : -1;
    }, cssPath);
    return idx >= 0 ? idx : null;
  } catch {
    return null;
  }
}

export interface ResolvedLocators {
  primary: Locator;
  fallbacks: Locator[];
  /** Extra flag worth surfacing on the node (never silently dropped). */
  note: string | null;
}

export async function resolveLocators(frame: Frame, raw: RawNode, cache: CountCache): Promise<ResolvedLocators> {
  const resolved: Array<{ locator: Locator; candidate: RawLocatorCandidate }> = [];
  let note: string | null = null;

  // Counts run concurrently; Promise.all preserves candidate priority order.
  const counts = await Promise.all(raw.candidates.map((c) => countMatches(frame, c, cache)));
  for (let i = 0; i < raw.candidates.length; i++) {
    const candidate = raw.candidates[i]!;
    const count = counts[i]!;
    if (count === null) {
      note = `A '${candidate.strategy}' locator candidate could not be evaluated by Playwright and was omitted.`;
      continue;
    }
    resolved.push({
      locator: {
        strategy: candidate.strategy,
        playwright: buildExpression(candidate),
        is_unique: count === 1,
      },
      candidate,
    });
  }

  if (resolved.length === 0) {
    // Should not happen (css/id candidates are near-universal) — flag loudly.
    return {
      primary: {
        strategy: "css",
        playwright: `locator(${q(raw.css_path || raw.tag)})`,
        is_unique: false,
        disambiguation: "No usable locator candidate was derived for this node; locate it manually.",
      },
      fallbacks: [],
      note,
    };
  }

  // Structural css paths are last-resort: never promoted to primary just for
  // being unique — a semantic-but-ambiguous locator plus disambiguation beats
  // brittle nth-child CSS.
  const eligible = resolved.filter((r) => !r.candidate.last_resort);
  const pool = eligible.length > 0 ? eligible : resolved;
  const firstUnique = pool.findIndex((r) => r.locator.is_unique);
  const primary = pool[firstUnique >= 0 ? firstUnique : 0]!;

  if (!primary.locator.is_unique) {
    const count = cache.get(`${primary.candidate.strategy}|${primary.candidate.role ?? ""}|${primary.candidate.value}`);
    const nth = await findNthIndex(frame, primary.candidate, raw.css_path);
    const hints: string[] = [];
    if (nth !== null) hints.push(`use .nth(${nth})`);
    if (raw.scope_hint) hints.push(`or scope with getByTestId('${raw.scope_hint}') before locating`);
    if (hints.length === 0) hints.push("scope with a stable ancestor or .filter() before locating");
    primary.locator.disambiguation = `${count ?? "multiple"} matches in frame; ${hints.join("; ")}.`;
  }

  // Payload discipline: when a unique semantic locator exists, brittle
  // last-resort candidates (structural CSS, generated ids) add bytes without
  // adding options — drop them from fallbacks. Cap fallbacks at 4.
  const hasUniqueSemantic = resolved.some((r) => r.locator.is_unique && !r.candidate.last_resort);
  const fallbacks = resolved
    .filter((r) => r !== primary)
    .filter((r) => !(hasUniqueSemantic && r.candidate.last_resort))
    .slice(0, 4)
    .map((r) => r.locator);

  return { primary: primary.locator, fallbacks, note };
}
