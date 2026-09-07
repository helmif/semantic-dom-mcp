/**
 * Output-boundary redaction for values the server itself typed into the page.
 *
 * The in-page engine never surfaces password-field values, but a password can
 * still leak through other surfaces: a "show password" toggle turns the field
 * into type=text, a page echoes the typed value into a status line, a dialog
 * or console message prints it. The server is the one party that knows which
 * strings are secrets (it typed them), so every string it emits is scrubbed.
 *
 * Registered: fill values whose target is a password field at fill time, and
 * fill values the caller marks `secret: true`. Kept in memory only, bounded.
 */
/**
 * Shorter values are not scrubbed: they collide with ordinary page copy (a
 * test password "salah" would blank the word out of a toast). Password fields
 * never report a value regardless of length, so this only affects echoes.
 */
export const MIN_SECRET_LENGTH = 8;
const MAX_SECRETS = 200;
const secrets = new Set<string>();

export const REDACTED = "[REDACTED]";

export function registerSecret(value: string): void {
  if (value.length < MIN_SECRET_LENGTH) return;
  if (secrets.size >= MAX_SECRETS) {
    const oldest = secrets.values().next().value;
    if (oldest !== undefined) secrets.delete(oldest);
  }
  secrets.add(value);
}

/** Test hook. */
export function clearSecrets(): void {
  secrets.clear();
}

export function redactString(text: string): string {
  if (secrets.size === 0) return text;
  let out = text;
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join(REDACTED);
  }
  return out;
}

/** Deep-scrubs every string in a JSON-serialisable value. */
export function redactDeep<T>(value: T): T {
  if (secrets.size === 0) return value;
  return walk(value) as T;
}

function walk(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
    return out;
  }
  return v;
}
