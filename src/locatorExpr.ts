/**
 * Strict parser for the Playwright locator expressions this server emits, so
 * an agent can hand a `playwright` string straight back to `session_act`,
 * `extract_semantic_dom_after` or `verify_locators` with no re-parsing on
 * its side. This is a grammar, not eval: only the forms the extractor
 * produces are accepted, and anything else is a structured error.
 *
 *   getByTestId('x')
 *   getByRole('button')                       getByRole('button', { name: 'Simpan' })
 *   getByLabel('x')  getByPlaceholder('x')    getByText('x')
 *   locator('css')
 *   optional scope prefix:
 *     getByRole('row', { name: 'X' }).<inner>
 *     getByRole('listitem').filter({ hasText: 'X' }).<inner>
 *     getByTestId('X').<inner>
 *   optional suffix: .nth(3)
 */
import type { ActionLocator } from "./browser.js";

const STR = String.raw`'((?:[^'\\]|\\.)*)'`;
const SCOPE_ROW = new RegExp(String.raw`^getByRole\('row', \{ name: ${STR} \}\)\.`);
const SCOPE_ITEM = new RegExp(String.raw`^getByRole\('listitem'\)\.filter\(\{ hasText: ${STR} \}\)\.`);
const SCOPE_TID = new RegExp(String.raw`^getByTestId\(${STR}\)\.(?=getBy|locator\()`);
const SCOPE_CSS = new RegExp(String.raw`^locator\(${STR}\)\.(?=getBy|locator\()`);
const INNER = new RegExp(
  String.raw`^(?:getByTestId\(${STR}\)|getByRole\(${STR}(?:, \{ name: ${STR} \})?\)|getByLabel\(${STR}\)|getByPlaceholder\(${STR}\)|getByText\(${STR}\)|locator\(${STR}\))(?:\.nth\((\d+)\))?$`,
);

function unquote(s: string): string {
  return s.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
}

export class LocatorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocatorParseError";
  }
}

/** Parses an emitted expression into the structured action locator. Throws LocatorParseError. */
export function parseLocatorExpression(expr: string): ActionLocator {
  let rest = expr.trim();
  let within: ActionLocator["within"];
  let m = SCOPE_ROW.exec(rest);
  if (m) {
    within = { kind: "row", value: unquote(m[1]!) };
    rest = rest.slice(m[0].length);
  } else if ((m = SCOPE_ITEM.exec(rest))) {
    within = { kind: "listitem", value: unquote(m[1]!) };
    rest = rest.slice(m[0].length);
  } else if ((m = SCOPE_TID.exec(rest))) {
    within = { kind: "test-id", value: unquote(m[1]!) };
    rest = rest.slice(m[0].length);
  } else if ((m = SCOPE_CSS.exec(rest))) {
    within = { kind: "css", value: unquote(m[1]!) };
    rest = rest.slice(m[0].length);
  }

  const i = INNER.exec(rest);
  if (!i) {
    throw new LocatorParseError(
      `Unsupported locator expression: ${expr}. Accepted: getByTestId/getByRole/getByLabel/getByPlaceholder/getByText/locator(...), ` +
        "optionally scoped by getByRole('row', { name }) / getByRole('listitem').filter({ hasText }) / getByTestId(...) / locator(...), with an optional .nth(i).",
    );
  }
  const [, tid, role, roleName, label, placeholder, text, css, nth] = i;
  let out: ActionLocator;
  if (tid !== undefined) out = { strategy: "test-id", value: unquote(tid) };
  else if (role !== undefined) out = { strategy: "role", role: unquote(role), value: roleName !== undefined ? unquote(roleName) : "" };
  else if (label !== undefined) out = { strategy: "label", value: unquote(label) };
  else if (placeholder !== undefined) out = { strategy: "placeholder", value: unquote(placeholder) };
  else if (text !== undefined) out = { strategy: "text", value: unquote(text) };
  else out = { strategy: "css", value: unquote(css!) };
  if (nth !== undefined) out.nth = Number(nth);
  if (within) out.within = within;
  return out;
}
