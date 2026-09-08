# Roadmap

## v0.2 — Multi-framework locator output (Cypress, WebdriverIO, Selenium)

The architecture already has the right seam: the in-page engine emits neutral
candidate *data* (`strategy` + `value` + `role`), and Playwright expressions
are rendered from it in one place (`src/extractor/locators.ts:buildExpression`).
Supporting another framework is a second renderer, not a second extractor.

Plan:

1. Add an optional `target_framework` input to `extract_semantic_dom`
   (`"playwright"` default — existing output is unchanged, schema stays v1;
   the `playwright` field keeps its name and simply carries the framework's
   expression, with a metadata note naming the framework).
2. Renderers per framework from the same candidates:
   - **Cypress**: `cy.get('[data-testid="…"]')`, `cy.contains('button', '…')`;
     with `@testing-library/cypress`: `cy.findByRole('button', { name: '…' })`.
   - **WebdriverIO**: `$('[data-testid="…"]')`, `$('aria/…')`.
   - **Selenium**: `By.cssSelector(…)`, with role/name resolved to attribute
     or XPath text selectors.
3. Per-framework conventions: `conventions://cypress` etc., plus a
   `framework` argument on the `write_playwright_test` prompt (rename to
   `write_test` when this lands).

Caveats to resolve before shipping (they are semantic, not cosmetic):

- **Uniqueness counting** currently uses Playwright's engine. For other
  frameworks the same conceptual locator can match differently — e.g. Cypress
  does **not** pierce shadow DOM unless configured, and has no native
  accessible-name engine. Options: count with the target framework's
  semantics approximated in-page, or keep Playwright counts and flag
  shadow/a11y-name locators with a framework-compat warning. Never present a
  Playwright-verified count as a guarantee for another engine.
- **Frame handling** maps differently (`frameLocator()` vs Cypress iframes
  needing plugins vs Selenium `switchTo().frame()`); `frame_path` stays the
  neutral truth, each conventions text explains the framework's mechanics.

## Shipped

What each version shipped lives in [CHANGELOG.md](../CHANGELOG.md); pushing
a tag turns that version's section into the GitHub Release notes. This file
only tracks what is next.

## Next

- **Progressive disclosure**: `extract_outline` (landmarks, forms, dialogs
  with counts) then scoped extraction (`scope`, `roles`, `visible_only`);
  `output: "file"` for large pages.
- **Locator verification** (`verify_locators` / spec lint): count every
  `getBy*` / `locator()` in a written spec against the live page; doubles as
  drift detection in CI against committed extracts.
- **Page object generation** from an extraction, with stable property names.
- **Conventions as a skill** (`SKILL.md` / `AGENTS.md`) plus a
  `get_conventions` tool, for clients that surface MCP prompts poorly.
- **Auth refresh**: a declared login flow with credentials from env only that
  rewrites the storageState file.

## Later
- **MCP SDK v2 migration** once it's stable (expected on/after 2026-07-28)
  and v1 approaches end of fixes — isolated to `src/server.ts` registration
  calls.
- **Benchmark growth**: commit A/B protocol results (benchmark/README.md) and
  longitudinal flake/review metrics once the team has 30 days of usage.

## Non-goals

Running the generated tests, cross-origin iframe contents, closed shadow root
contents, any cloud/telemetry, storing page data beyond a call.
