# Changelog

All notable changes to `semantic-dom-mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). The Semantic JSON contract has its own
`schema_version`: additive changes bump its minor, breaking changes its major.

Pushing a `vX.Y.Z` tag publishes to npm and creates a GitHub Release whose body
is that version's section below. The release workflow refuses a tag with no
matching section.

## [Unreleased]

## [0.5.1] - 2026-09-08

Fixes from the first v0.5 run against a real dev environment (guest
add-to-cart on an e-commerce seller platform; see
`benchmark/FLOW-VALIDATION.md`).

### Fixed

- `.nth()` disambiguation is now found by containment, so a click-target
  card located by its heading text (the locator resolves to the `<h3>`, not
  the card) gets an index. Before, a product listed in three sections had
  "3 matches" and no index, and the click failed under strict mode.
- Click-target cards are named by their heading; the full card text stays in
  `text_content` instead of becoming a 120-character accessible name.
- Focus-trap sentinels (focusable, no role, no name, no content, as dialog
  libraries insert at both ends of a modal) are no longer extracted. They
  only ever produced structural CSS locators.
- Elements carrying `aria-label` but no role get a `getByLabel` candidate;
  Playwright's `getByLabel` matches `aria-label`, so the count engine can
  verify it instead of falling back to structural CSS.

## [0.5.0] - 2026-09-07

Flows, not pages. The single-shot tools see one page; real scenarios are
flows, and the first A/B run's only remaining iterations (a redirect target,
a late modal) were behavior facts the tool never captured.

### Added

- Persistent sessions: `session_open`, `session_act`, `session_extract`,
  `session_close`, `session_list`. One live page across tool calls, fresh
  context per session, storageState applied.
- `observed` block on `session_act` and `extract_semantic_dom_after`:
  main-frame navigations, xhr/fetch/document requests as method + path +
  status, console errors, dialogs (dismissed), popups (closed). Feeds
  `waitForURL` / `waitForResponse` from facts.
- Snapshot diff: `session_extract({ diff_against })` returns added, removed
  and changed nodes plus the behavior observed in between. About 90% smaller
  than re-extracting the page after a step.
- Schema 1.2 (additive): `value` (never for credential fields),
  `aria_expanded`, `aria_selected`, `aria_invalid`, `described_by`,
  `validation_message`, `options` on every node; `observed` and
  `snapshot_id` on extractions.
- Declared action types `select` and `goto` (allowlisted); `fill` takes
  `secret: true`.
- Secret redaction: values typed into password fields (detected at fill
  time) or flagged `secret` are scrubbed from every string the server
  returns. Credential `autocomplete` tokens suppress `value` like
  `type=password`.
- MCP tool annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint`)
  on every tool.
- Env: `QA_MCP_SESSION_TTL_MS` (default 10 min), `QA_MCP_MAX_SESSIONS`
  (default 3).
- Conventions: flow, behavior and value-assertion rules.
- `benchmark/FLOW-VALIDATION.md`: pre-release flow check on a fixture app;
  generated Playwright tests run green unmodified.

### Changed

- `is_visible` now matches Playwright's `toBeVisible()`: width and height
  both > 0, `visibility` not hidden. `opacity:0` and `aria-hidden` no longer
  count as hidden. Found by running a generated test: the extractor had
  called an empty live region visible.
- Live-region notes name the container the text was borrowed from and tell
  the agent to assert on it.
- Sessions check the allowlist before any action, after every action, after
  a failed action and before every snapshot; a session found off-allowlist
  is closed on the spot.

### Fixed

- Diff identity no longer depends on the resolved primary locator, so a
  hidden node becoming visible is reported as changed (with its locator
  switch) rather than removed + added.
- `aria-invalid=""` is read as "not set", not as invalid.
- A fetch that completed and was then aborted by a navigation is no longer
  marked `failed`.

## [0.4.0] - 2026-07-07

From the chat-flow A/B against a hand-written suite.

### Added

- Opt-in click-target heuristic (`include_click_targets`): JS-click cards
  (cursor:pointer boundaries with content, no anchor/role/test-id) are
  included with heading-text locators and a heuristic `context_note`.
- Capture-time uniqueness rule in the team conventions and the after-tool
  description: accumulating UI (chat threads, lists) can multiply matches
  after capture; scope with `.first()` / `.filter()`.
- `docs/HOW-IT-WORKS.md` deep dive.

## [0.3.2] - 2026-07-06

### Changed

- Republished so npmjs.com renders the npx-first README. No code change.

## [0.3.1] - 2026-07-05

Three library-agnostic fixes from a real-world comparison against an existing
hand-written Playwright suite (`benchmark/AB-RESULTS.md`).

### Fixed

- Empty `role=alert` / `status` live regions get `text_content` from their
  enclosing container (flagged), so toast messages become assertable.
- Descendant `img[alt]` is used as the text equivalent for image-only
  elements; logo links get `getByRole('link', { name })` instead of
  structural CSS.

### Added

- `wait_selector_after` on `extract_semantic_dom_after`: deterministic
  post-action wait for late-rendering modals and toasts.

## [0.3.0] - 2026-07-05

Initial public release on npm.

### Added

- `extract_semantic_dom`: live page to Semantic JSON with Playwright-native
  locators, uniqueness verified by Playwright's own engine.
- `extract_semantic_dom_after`: declared fill/click/press/wait actions, then
  a snapshot of the resulting state, with a post-action allowlist guard.
- `list_frames` and `check_auth` diagnostics.
- `write_playwright_test` prompt and `conventions://playwright` resource.
- Schema 1.1: `properties.href` on links.
- Framework-generated ids (rc_select, React `useId`, Radix, MUI, Ember)
  demoted to last resort with a note.
- Payload slimming: brittle fallbacks dropped when a unique semantic locator
  exists; fallbacks capped at 4.
- `viewport: "mobile"` preset.
- Parallel locator verification, bounded concurrency, document order kept.
- Release workflow: pushing a `v*` tag publishes to npm.

[Unreleased]: https://github.com/helmif/semantic-dom-mcp/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/helmif/semantic-dom-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/helmif/semantic-dom-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/helmif/semantic-dom-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/helmif/semantic-dom-mcp/releases/tag/v0.3.0
