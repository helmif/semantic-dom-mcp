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

## Shipped in v0.2 (2026-07-05)

- **Declared-actions capture** (multi-snapshot):
  `extract_semantic_dom_after` runs a bounded fill/click/press/wait list and
  snapshots the post-interaction state (toasts, validation, dialogs), with a
  post-action allowlist guard. Approved as the single exception to the
  read-only rule.
- **Inclusion amendment**: `alert`, `status`, `alertdialog`, `dialog` roles
  are now extracted; their role locators respect ARIA author-naming
  (`getByRole('alert')` bare unless an aria-label exists).

## Shipped in v0.3 (2026-07-05)

- Schema 1.1: `properties.href` on links (agents can discover navigable pages).
- Framework-generated ids (rc_select, React useId, Radix, MUI, Ember...)
  detected and demoted to last-resort with a context note.
- Payload slimming: brittle fallbacks dropped when a unique semantic locator
  exists; fallbacks capped at 4.
- "0 nodes" extractions now carry a self-explaining hint note.
- Parallel locator verification (bounded concurrency, order-preserving).
- `viewport: "mobile"` preset; `check_auth` diagnostic tool.
- Release workflow: pushing a `v*` tag publishes to npm (needs the
  `NPM_TOKEN` repo secret).

## Shipped in v0.3.1 (2026-07-05)

Three library-agnostic fixes from a real-world comparison against an existing
hand-written Playwright suite:

- Empty `role=alert`/`status` live regions get `text_content` from their
  enclosing container (flagged) — toast messages become assertable.
- Descendant `img[alt]` is used as the text equivalent for image-only
  elements — logo links get `getByRole('link', { name: ... })` instead of
  structural CSS.
- `wait_selector_after` on `extract_semantic_dom_after` — deterministic
  post-action wait for late-rendering modals/toasts.

## Shipped in v0.4 (2026-07-07)

From the chat-flow A/B against a hand-written suite:

- **Opt-in click-target heuristic** (`include_click_targets`): JS-click cards
  (cursor:pointer boundaries with content, no anchor/role/test-id) are
  included with heading-text locators and a heuristic context_note — closes
  the "product cards are invisible" gap seen on two real listings.
- **Capture-time uniqueness rule** added to the team conventions and the
  after-tool description: accumulating UI (chat threads, lists) can multiply
  matches after capture — scope with .first()/.filter().

## Shipped in v0.5 (2026-09-07): flows, not pages

The single-shot tools see one page. Real scenarios are flows, and the first
A/B run's only remaining iterations (a redirect target, a late modal) were
behavior facts the tool never captured. v0.5 closes both gaps.

- **Persistent sessions**: `session_open` → `session_act` → `session_extract`
  → `session_close` (`session_list` for diagnostics). One live page across
  calls, fresh context per session, storageState applied. Guardrails: the
  allowlist is re-checked after every action batch and before every
  snapshot (an off-allowlist session is closed, never extracted), idle TTL
  (`QA_MCP_SESSION_TTL_MS`), open-session cap (`QA_MCP_MAX_SESSIONS`), one
  in-flight call per session, bounded snapshot history.
- **Behavior capture**: `observed` on `session_act` and on
  `extract_semantic_dom_after`. Main-frame navigations, xhr/fetch/document
  requests as method + path + status (bodies never read, query strings
  stripped), console errors, dialogs (dismissed), popups (closed). Feeds
  `waitForURL` / `waitForResponse` from facts.
- **Snapshot diff**: `session_extract({ diff_against })` returns added,
  removed and changed nodes plus the behavior observed between the two
  snapshots. ~90% smaller than re-extracting the page after a step.
- **Schema 1.2** (additive): `value` (never for passwords), `aria_expanded`,
  `aria_selected`, `aria_invalid`, `described_by`, `validation_message`,
  `options` on every node; `observed` and `snapshot_id` on extractions.
- New declared action types `select` and `goto` (allowlisted); `fill` takes
  `secret: true`.
- **Secret redaction**: values typed into password fields (detected at fill
  time) or flagged `secret` are scrubbed from every string the server returns.
  Credential `autocomplete` tokens suppress `value` like `type=password` does.
- **`is_visible` now matches Playwright's `toBeVisible()`** (width and height
  both > 0; opacity and `aria-hidden` no longer count). Found by running a
  generated test against a fixture: the extractor had called an empty live
  region visible.
- MCP tool annotations (`readOnlyHint`, `openWorldHint: false`) on every tool.
- Conventions gained flow, behavior and value-assertion rules.

## Next

- **Locator verification** (`verify_locators` / spec lint): count every
  `getBy*` / `locator()` in a written spec against the live page; doubles as
  drift detection in CI against committed extracts.
- **Progressive disclosure**: `extract_outline` (landmarks, forms, dialogs
  with counts) then scoped extraction; `output: "file"` for large pages.
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
