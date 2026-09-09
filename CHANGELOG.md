# Changelog

All notable changes to `semantic-dom-mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). The Semantic JSON contract has its own
`schema_version`: additive changes bump its minor, breaking changes its major.

Pushing a `vX.Y.Z` tag publishes to npm and creates a GitHub Release whose body
is that version's section below. The release workflow refuses a tag with no
matching section.

## [Unreleased]

## [0.8.0] - 2026-09-08

The token release. A Codex Desktop benchmark on a real admin page showed
0.7.0's full extraction at 3.9x the size of the native accessibility tree
and 55% of primary locators ambiguous on a table. 0.8 changes how an agent
works with the server: map the page cheaply, extract one region, act with
the snapshot in the same call, paste locators back verbatim, verify the
written spec. Measured on three authenticated pages of a real seller
dashboard (same pages, same session, same wait):

| Page | Aria snapshot (native tree) | Outline (0.8) | Full extraction 0.7 → 0.8 |
| --- | ---: | ---: | ---: |
| Home | 11,699 ch | 541 ch | 45,807 → 26,922 ch |
| Product detail | 13,904 ch | 2,133 ch | 47,448 → 33,931 ch |
| Batch cart | 2,595 ch | 458 ch | 10,988 → 9,023 ch |

The guest add-to-cart flow (outline → scoped listing → open product →
add-to-cart with the diff in the same call → verify the spec's locators):
**~3,800 est. tokens**, against ~18,300 in 0.6 and ~39,200 in 0.5, with all
four spec locators verified unique.

### Added

- `extract_outline` and `session_extract({ mode: "outline" })`: the page as
  a map. Landmark regions with a `selector` accepted by `scope`, structured
  tables (headers, row identity, cells), open dialogs (label/value fields),
  current alert text. A few hundred to a few thousand characters.
- Scoped extraction: `scope` (CSS selector; resolves to the last visible
  match so stacked dialogs work), `roles`, `visible_only`,
  `max_output_chars` (deterministic document-order truncation reported in
  `omitted`), `include_tables`. On every extraction tool and in sessions.
- Locators scoped to the extraction root: inside `scope`, an ambiguous
  locator becomes `locator('<scope>').getByRole(...)`, verified unique
  within it (schema 1.5 adds `within.kind: "css"`).
- `session_act({ then_extract })`: the diff, a scoped extraction or an
  outline in the same call. One round trip per step.
- Action locators accept the `playwright` expression string verbatim
  (`locator: { playwright: "getByRole('row', { name: 'X' }).getByPlaceholder('0')" }`),
  parsed by a strict grammar. No re-parsing on the agent side.
- `verify_locators` and `session_verify_locators`: count every expression
  from a written spec against the live page; matches, uniqueness, first
  match, summary. The closed loop after the test is written, and a CI drift
  check.
- `get_conventions` for clients that do not surface MCP prompts.
- Structured tables fold component-library split tables (header table +
  body table) into one, skip layout/measure rows, and use `innerText` so
  cells keep spaces ("Rp35.000 Rp45.000 22%").
- Unlabeled framework controls carry a `context_note` with the text before
  them, flagged as a hint.
- Benchmark: raw arm uses the same storageState and wait as the MCP arm
  (parity bug fixed), and a Playwright `ariaSnapshot()` arm stands in for
  the native accessibility tree.
- Startup diagnostic line on stderr (version, browser, config); Chromium
  launch fails fast with an install hint; `check_auth` warns when the
  storageState file is readable by other users.

### Changed

- Row and list-item identity is the cell unique among sibling rows (product
  name, SKU), not the first short cell (a status badge shared by every
  row). This is what made 55% of a table page's primaries ambiguous.
- Structural `nth-child` CSS paths never go on the wire (they were 500+
  characters per ambiguous node on real SPAs); they stay internal for
  `.nth()` correlation.
- `@modelcontextprotocol/sdk` 1.30; `npm audit --omit=dev` is clean and a
  release gate.
- README no longer claims universal token savings. The claim is: verified
  locators, structured assertion data, observed behavior, and a first look
  at a page that is smaller than the native accessibility tree.

## [0.7.0] - 2026-09-08

Scoped locators, from the first authenticated run against a real seller
dashboard: a variant table whose custom radios have no name and whose
quantity fields all share `placeholder="0"`, a buyer picker with five
identical buttons, and a cart whose checkboxes live inside test-id
containers.

### Added

- Schema 1.4: `Locator.within` (`{ kind: "row" | "listitem" | "test-id",
  value }`). The in-page engine finds the nearest scoping container (a
  test-id ancestor, a table row, a list item) and emits scoped variants of
  the semantic candidates after the unscoped ones: a nameless control gets
  a bare role inside its container (`getByRole('row', { name: 'Charizard'
  }).getByRole('radio')`), a repeated one gets disambiguated
  (`getByRole('row', { name: 'Charizard' }).getByPlaceholder('0')`,
  `getByRole('listitem').filter({ hasText: 'Puthera' }).getByRole('button',
  { name: 'Pilih Pembeli Ini' })`, `getByTestId('customer-checkbox-flex')
  .getByRole('checkbox')`). All verified by Playwright's own count like
  every other locator. Declared action locators accept the same `within`.
- Icon-only controls are named from `<svg aria-label>` or `<svg><title>`.
- `benchmark/FLOW-VALIDATION.md`: authenticated add-to-cart run, generated
  test green on the live dev site.

### Changed

- A textless `<label>` wrapping a control is no longer extracted as a node
  of its own (component-library checkbox chrome).

## [0.6.1] - 2026-09-08

Audit release: three independent review angles over everything since 0.5.0
plus live probes against a real dev environment. Every item below has a
regression test.

### Changed

- `wait_for` default is now `auto`: `load`, then no xhr/fetch request in
  flight and no DOM mutation for 500 ms (bounded at 6 s). The tracker is
  attached before navigation so a data request fired during parsing counts.
  On a real dev site the previous default (`networkidle`) timed out after
  30 s because analytics never let the network go idle, and `load` returned
  an empty shell. `goto` actions settle the same way.
- Accessible names follow accname precedence: `aria-labelledby`, then
  `aria-label`, then the associated `<label>`, then content. `getByLabel`
  candidates use the same order (Playwright's), and are skipped when they
  would duplicate the role locator's name.
- `action_failed` messages carry the reason from Playwright's call log
  (`intercepts pointer events`, `not visible`, `strict mode violation …`).
- README links are absolute so they work on npmjs.com.

### Fixed

- Diff identity is computed in-page from the element's own attributes (test
  attribute, human-authored id, placeholder, else tag + role + name). Since
  0.6.0 stopped verifying locators after the first unique one, identity
  derived from verified locators could flip between snapshots and turn a
  disabled-and-relabelled button into removed + added.
- Diffing against the oldest kept snapshot no longer evicts that snapshot
  before the diff is computed.
- A failed Chromium launch is not cached, and a browser that disconnects is
  relaunched on the next call.
- In-page extraction (30 s) and title reads (5 s) are bounded; a hung page
  surfaces as `page_unresponsive` instead of a session stuck busy forever.
- A context created for a session is closed if opening the page fails.
- Focusable elements with an explicit role, a `title`, or an inline `<svg>`
  are kept; `aria-labelledby` pointing at nothing no longer counts as a name.
- `.nth()` correlation inside a click-target card prefers the heading, so a
  same-text badge before it does not steal the index.
- Click-target cards derive candidates from the heading name, so a role
  candidate never carries the text blob.
- Re-typed secrets move to the newest end of the redaction set; a locator
  whose text was redacted is flagged not unique with a note.
- Secret detection happens after the fill, so a missing target no longer
  waits twice.
- Docs: absent property means null, never false; after-tool action list;
  request cap; undocumented error codes (`session_busy`, `action_failed`,
  `wait_selector_timeout`, `page_unresponsive`, `internal_error`).
- Test coverage: the MCP wire format is now tested end to end through the
  server (compact JSON, no null node fields, tool annotations).

## [0.6.0] - 2026-09-08

Same facts, a third of the tokens. Measured on real v0.5 output a node cost
300 to 385 tokens; most of it was indentation, `null` properties, fallback
locators nobody uses when the primary is unique, and text repeated between
`text_content` and `accessible_name`.

### Changed

- Schema 1.3 wire format. Results are emitted as compact JSON (no
  indentation) and node fields are omitted when they carry no information:
  a `null` field, `frame_path: []`, `in_shadow: false`, `kind: "element"`,
  `fallback_locators: []`, and `text_content` equal to `accessible_name`.
  Absent means null/false/empty. `is_visible` is always present. Diff
  `changes` keep `null` from/to values, since there the null is the fact.
  Internally the shape stays full and fixed; `src/compact.ts` applies the
  rules once at the tool-result boundary.
- Fallback locators appear only when the primary is not unique or is a
  brittle strategy (css/id), capped at 2.
- Locator verification stops at the first unique semantic candidate instead
  of counting every candidate. Ambiguous nodes still run the whole chain, so
  a unique css fallback and `.nth()` correlation remain available for them.
  Cuts Playwright round trips from about one per candidate to about one per
  node on well-labelled pages.
- The diff identity rule and the wire rules are stated once, in the tool
  descriptions and server instructions, instead of in every result's notes.
- `npm run bench` measures the wire payload, not the pretty-printed internal
  object.

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

[Unreleased]: https://github.com/helmif/semantic-dom-mcp/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/helmif/semantic-dom-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/helmif/semantic-dom-mcp/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/helmif/semantic-dom-mcp/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/helmif/semantic-dom-mcp/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/helmif/semantic-dom-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/helmif/semantic-dom-mcp/releases/tag/v0.3.0
