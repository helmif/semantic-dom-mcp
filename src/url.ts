/** One URL parser for the whole server; every caller gets the same fallback. */
export function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function safeOrigin(url: string): string | null {
  return parseUrl(url)?.origin ?? null;
}

/**
 * Origin + path only. Query strings (and fragments, userinfo) are dropped
 * everywhere a URL is recorded or echoed: they may carry tokens.
 */
export function stripQuery(url: string): string {
  const u = parseUrl(url);
  if (u) return `${u.origin}${u.pathname}`;
  return (url.split("#")[0] ?? url).split("?")[0] ?? url;
}
