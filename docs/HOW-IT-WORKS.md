# How semantic-dom-mcp works — the full deep dive

This document explains the machinery end to end: why the tool exists, how a live page becomes
Semantic JSON, why the locators can be trusted, and where the honest boundaries are. It assumes
you've skimmed the [README](../README.md); it does not assume you know MCP internals.

---

## 1. The goal (and the non-goal)

Teams using AI agents to write UI tests hit two failure modes:

1. **Hallucinated selectors.** An agent asked to "write a login test" without page context invents
   `#email-input` and `data-testid="submit-btn"` — names that *sound* right and don't exist.
   Feeding it raw HTML helps but doesn't verify anything, and every engineer's agent picks
   different selectors for the same element.
2. **Context cost.** A modern SPA page is 400–650 KB of HTML — roughly 100,000–160,000 estimated
   tokens. One page barely fits an agent's context window; a multi-page flow doesn't fit at all.

The goal is therefore narrow and checkable: **eliminate hallucination at the locator layer, and
make extraction identical for every person** — same page, same output, byte for byte. The
explicit non-goal: the tool does not write correct test *logic*, pick scenarios, or guarantee
coverage. Engineers and reviewers still do that. Every design decision below traces back to this
split.

## 2. Why an MCP server (and not an extension, or pasted HTML)

**MCP (Model Context Protocol)** is the standard by which AI agents call external tools. An MCP
server is a small local process; the agent launches it, discovers its tools, and calls them with
JSON arguments. Putting extraction behind MCP does three things a browser extension or a
copy-paste workflow cannot:

- **One implementation for everyone.** The extraction rules live in one versioned, reviewed
  codebase — not in each engineer's habits.
- **Conventions travel with the data.** The server also serves the team's test-writing rules as a
  prompt. Changing "how we write tests" becomes a pull request, not a Slack announcement people
  forget.
- **The agent can *act* on it.** Tools compose: extract, then extract-after-actions, then write —
  all inside one agent conversation, no human ferrying JSON between windows.

## 3. The hard constraint that shapes everything

**A Node process has no DOM.** You cannot "parse a page" from a server — HTML text is not a page.
A page is HTML *after* JavaScript ran, styles resolved, frames loaded, and shadow roots attached.
So the server drives a real browser (Chromium via Playwright) and runs its analysis **inside the
page** with `page.evaluate`. Three sub-constraints follow:

- `page.evaluate` cannot cross iframe boundaries → same-origin frames are enumerated and
  extracted **one by one**, each node tagged with its `frame_path`.
- Cross-origin iframes and closed shadow roots are unreachable from page JavaScript → they are
  recorded as **opaque boundary marker nodes**, never silently skipped.
- Code injected into the page can't `import` anything → the in-page engine is a set of
  self-contained functions, stringified with `Function.prototype.toString()` and concatenated
  into one script (see §5).

## 4. The pipeline, step by step

A call to `extract_semantic_dom({ url })` flows through six stages:

```
 guardrails → browser/context → navigate & wait → enumerate frames
      → IN-PAGE ENGINE (per frame) → SERVER-SIDE LOCATOR RESOLUTION → assemble JSON
```

### Stage 1 — Guardrails before anything runs

Tool inputs arrive from an LLM and are treated as untrusted. The input schema is strict
(`additionalProperties: false` — unknown keys are rejected, not ignored). The URL must be
http/https, and its host must match `QA_MCP_ALLOWED_HOSTS` — a **deny-by-default** allowlist, so
an agent cannot be talked into pointing the browser at an arbitrary site. No allowlist configured
means no navigation at all.

### Stage 2 — Browser and context

Chromium launches once (headless) and is reused across calls; each extraction gets a **fresh
browser context** (clean cookies/storage) that is closed afterward — nothing persists between
calls. If `QA_MCP_STORAGE_STATE` points to a Playwright session file, the context loads it, which
is how logged-in pages are extracted without the server ever seeing credentials. A `viewport`
preset can emulate mobile. One pre-navigation instrumentation is installed here: a wrapper around
`Element.prototype.attachShadow` that *records* which elements attach **closed** shadow roots
(the platform offers no way to detect them after the fact). The wrapper changes no behavior — the
page is observed, never modified.

### Stage 3 — Navigate and wait

`page.goto(url, { waitUntil: "load" })`, then (default `wait_for: "auto"`) a **DOM-quiet wait**:
a `MutationObserver` inside the page resolves once nothing has changed for 500 ms, bounded at
6 s. Modern SPAs render *after* the `load` event, so snapshotting at `load` returns an empty
application shell; and `networkidle`, the previous default, never fires on pages with analytics
beacons or polling (a real dev environment timed out after 30 s). DOM quiet is what "the page
has rendered" means in practice, and it costs at most the quiet window. `load`,
`domcontentloaded` and `networkidle` remain selectable. An optional `wait_selector` waits for a
specific element, which beats time-based waiting for slow dashboards, and a 0-node extraction
carries a hint saying so.

### Stage 4 — Frame enumeration

`page.frames()` yields the frame tree. For each frame the server computes a selector for its
`<iframe>` element in the parent (`iframe#id` → `iframe[name=…]` → `iframe >> nth=i`), producing
the `frame_path` chain a test needs for `frameLocator()`. Each frame is classified same-origin or
cross-origin relative to the main document; cross-origin frames (and everything inside them)
become one `cross_origin_frame` marker node with URL and name — visible in the output, contents
untouched.

## 5. The in-page engine — how a page becomes data

This is the part people usually mean by "how does it parse the page." The engine is TypeScript
functions written under one rule: **no imports, no module state, DOM globals only** — because
they execute inside the page. At call time they are stringified and concatenated into a single
function expression, so they can call each other by name, and evaluated per frame.

### 5.1 Traversal — a forest, not a tree

An iterative stack walk starts at `document.documentElement`. It is a *forest* because open
shadow roots are separate trees: when an element has an open `shadowRoot`, its shadow children
are pushed too, flagged `in_shadow: true`. `<script>`, `<style>`, `<svg>`, `<template>`,
`<noscript>`, and `<head>` are never descended into; iframes are skipped here because Stage 4
handles them at the right layer. Elements the closed-shadow instrumentation marked become
`shadow_boundary` nodes. Two caps protect against pathological pages — `MAX_DEPTH` 50 and
`max_nodes` (default 5000) — and hitting either sets `truncated: true` **plus a note**. This is
the tool's first principle in action: *flag, never hide*. Nothing is ever dropped silently.

### 5.2 Which elements become nodes

An element is included if **any** of these hold:

- it carries a test attribute (`data-testid`, `data-cy`, `data-qa`, `data-test`);
- it is natively interactive (`input`, `button`, `a`, `select`, `textarea`, `label`);
- its ARIA role (explicit or implied by tag/type) is interactive — button, link, checkbox, radio,
  tab, menuitem, switch, combobox, textbox, option — **or a notification/dialog surface**: alert,
  status, alertdialog, dialog (tests assert toasts and modals constantly);
- it has a non-default `tabindex` and a name or content (a custom focusable control). A
  focusable element with no role, no name and no content is a focus-trap sentinel, as dialog
  libraries insert at both ends of a modal, and is skipped: it could only yield a structural CSS
  locator.

Everything else — layout wrappers, decorative divs — is excluded, keeping the output factual and
small. One documented exception exists because real listings demanded it: with
`include_click_targets: true` (default **off**), elements at a `cursor: pointer` **boundary**
(their parent chain isn't pointer — cursor is inherited, so this catches the card root, not its
thirty descendants) that carry content are included as heuristic nodes, each stamped with a
`context_note` saying so. That's the pattern JS-router product cards use: clickable, yet carrying
no anchor, role, or test-id.

### 5.3 Visibility: Playwright's rule, resolved cheaply

`is_visible` exists to predict `expect(locator).toBeVisible()`, so it follows Playwright's own
definition and nothing else: false if `display:none` (self or ancestor), `visibility:hidden` or
`collapse`, or a bounding box whose width **or** height is zero (`display:contents` delegates to
its children). Opacity, `aria-hidden` and `offsetParent` do not count for Playwright and
therefore not here either. Earlier versions treated `opacity:0` and `aria-hidden` as hidden and a
box as hidden only when both dimensions were zero; v0.5 aligned the rule after a generated test
asserted `toBeVisible()` on an empty live region the extractor had called visible. The
`display:none` ancestor flag is **carried down the traversal stack** so each element is examined
once. Hidden elements are still *included*, since tests assert hidden-ness all the time, just
flagged.

### 5.4 Accessible name — what Playwright will call this element

Precedence: `aria-label` → `aria-labelledby` (resolved and joined) → an associated `<label>` →
the element's collapsed text → a descendant image's `alt` (how logo links get real names). Two
subtleties learned from real pages: ARIA `alert`/`status`/`dialog` roles never take their name
from contents, so their role locator is emitted bare (`getByRole('alert')`) unless an author name
exists; and when a notification live region is *empty* (many toast libraries render the message
in a sibling), the message text is pulled from the enclosing container and flagged — so the toast
copy is assertable.

### 5.5 Scoping: the container a control lives in

A custom radio in a variant table has no name of its own; the name is in the next cell. Five
"Pilih Pembeli Ini" buttons are identical; what differs is the buyer card around each. A QA
engineer writes those locators by scoping: `getByRole('row', { name: 'Charizard' })
.getByRole('radio')`, `getByRole('listitem').filter({ hasText: 'Puthera' }).getByRole('button', {
name: 'Pilih Pembeli Ini' })`, `getByTestId('customer-checkbox-flex').getByRole('checkbox')`. The
engine does the same (v0.7): for each element it finds the nearest scoping container, a test-id
ancestor first (stable), else a table row (Playwright names rows from their content, and the
first short cell is used as a substring name), else a list item (filtered by its first short
text). It then emits scoped variants of the semantic candidates after the unscoped ones, plus a
bare scoped role for a control with no name at all. A unique unscoped locator still wins;
structure stays last. The node carries `within` so a declared action can address the same
element, and the expression is counted by Playwright like any other.

### 5.6 What the engine emits: candidates, not strings

For each node, the in-page engine emits locator **candidate data** — `(strategy, value, role)`
tuples in the team-priority order: test-id → role+name → label → placeholder → text → id →
structural CSS. Two demotions apply: framework-generated ids (`rc_select_*`, React `useId`
`:r…:`, Radix, MUI, Ember, select2 patterns) are marked last-resort because they change between
builds, and the structural CSS path (`html > body:nth-child(2) > …`) is always last-resort — it
exists for correlation, and as the primary only when literally nothing else does. Keeping
candidates as *data* rather than final strings is what makes the next stage possible — and what
will someday let the same extraction render Cypress or WebdriverIO selectors.

## 6. Server-side resolution — why the locators can be trusted

Back on the Node side, each candidate becomes a real Playwright expression
(`getByRole('button', { name: 'Pay Now' })`) **and is counted against the live frame with
Playwright's own engine**: `frame.getByRole(...).count()`. This is the accuracy core, and the
reason `is_unique` means something:

- The count uses **the exact engine the emitted expression will run under** — including
  Playwright's full accessible-name algorithm and its automatic open-shadow piercing. No
  re-implementation, no approximation drift.
- The primary locator is the **first verified-unique semantic candidate**. If none is unique, the
  best semantic candidate is still returned — with `is_unique: false` and concrete
  `disambiguation`: a computed `.nth(i)` index (found by correlating the element's structural
  path against the match list) and, when available, a stable ancestor test-id to scope with.
- Candidates are verified in priority order and verification **stops at the first unique
  semantic candidate** (v0.6): the primary is what a test uses, and once it is unique the rest
  would only be fallbacks nobody reads. Ambiguous nodes run the whole chain, so a unique
  structural fallback and the `.nth()` correlation stay available for them. Counts are cached
  per frame and nodes resolve in bounded parallel batches.

This stage regularly *catches the tool's own mistakes*: when an emitted expression wouldn't
actually match (a name-from-content assumption on an `alert`, say), the count comes back 0 and
the candidate is demoted — honesty enforced by machinery rather than by care.

**One semantic worth engraving: uniqueness is verified *at capture time*.** A chat thread that
gains messages can turn a unique test-id into four matches an hour later. The conventions warn
agents to scope accumulating UI with `.first()`/`.filter()` for exactly this reason.

## 7. Assembly — the contract

Everything lands in one `SemanticExtract` JSON: `page_metadata` (title, final URL, timestamp,
node and frame counts, `truncated`, and human-readable `notes` carrying every warning the
pipeline generated) plus `interactive_nodes`. Internally, properties that don't apply are
`null`, never omitted, so diffing and tests reason about one fixed shape. **On the wire** (schema
1.3, `src/compact.ts`) the same object is emitted as compact JSON with the empty parts left out:
`null` fields, `frame_path: []`, `in_shadow: false`, `kind: "element"`, empty
`fallback_locators`, and `text_content` when it equals `accessible_name`. An absent property is
null (not applicable, never false); absent structure is the default. `is_visible` is always
present. Measured on real pages this is about a third
of the tokens for the same facts. The schema is versioned and frozen: additive changes bump the
minor, breaking changes would bump the major, and agents can rely on the shape.

Output size in practice: 92–97% smaller than the raw DOM of the same page, and byte-identical
across repeated runs of an unchanged page — which is what makes two engineers start from the same
facts.

## 8. Capturing what a snapshot can't see: `extract_semantic_dom_after`

A snapshot cannot contain the login-error toast, because that UI exists only *after* an
interaction — and the extractor must never improvise interactions. The resolution is **declared
actions**: the agent passes a bounded list (`fill`, `click`, `press`, `select`, `goto`, `wait`; max 20) using
locator data from a prior extraction; the server performs them in the main frame and snapshots
the result. Deliberately *not* an arbitrary-script API — every action is schema-validated, fill
values are never logged or echoed into errors (they may be credentials), each action has a
timeout, and after the actions run the page's host is re-checked against the allowlist: if the
actions navigated somewhere non-allowlisted, nothing is extracted. For late-rendering UI,
`wait_selector_after` waits for a specific element instead of guessing a settle delay.

## 8b. Flows: sessions, observed behavior, and diffs (v0.5)

The single-shot tools answer "what is on this page". A scenario is a sequence of pages and
states, and three things a test needs live *between* snapshots: where the page navigated, which
requests it made, and what changed. v0.5 adds a session layer for exactly that.

**Sessions.** `session_open` creates a fresh browser context (storageState applied) and one page
that stays open across tool calls. In-page work is bounded (extraction 30 s, title 5 s) so a page
whose JavaScript hangs surfaces as `page_unresponsive` instead of a session stuck busy forever;
a browser that crashes is relaunched on the next call. `session_act` runs a declared action list on it (the same
bounded types as the after-tool, plus `select` and an allowlisted `goto`); `session_extract` runs
the same in-page engine and locator resolution as Stage 5 and 6 on the page's current state;
`session_close` releases the context and is idempotent. Guardrails are the single-shot ones plus
session-specific limits: the allowlist is checked before any action runs, after every single
action, after a failed action, and before every snapshot, and a session found off-allowlist at any
of those points is closed rather than acted on or extracted; sessions expire after an idle TTL,
are capped in number (the slot is reserved before any asynchronous work, so concurrent opens
cannot exceed the cap), accept one in-flight call at a time, and keep at most five snapshots in
memory. Nothing is written to disk.

**Observed behavior.** From the moment a session opens, Playwright page events are recorded:
main-frame `framenavigated` (URL changes, in order), `request`/`response`/`requestfailed` for
xhr/fetch/document/eventsource/websocket resources (method, origin + path, status; static assets
are counted in `dropped`, not listed; up to 500 requests per snapshot interval), `console` errors
and warnings, `pageerror`, `dialog` (recorded, then dismissed) and `popup` (URL recorded at the
event, then closed at once). Everything is recorded synchronously at event time, so the slice
`session_act` returns is complete when the call returns; a snapshot carries everything since the
previous snapshot, so a diff between consecutive snapshots includes the behavior in between. This
is observation only: the server never issues a request of its own, never reads a body, and strips
query strings because they may carry tokens. The after-tool got the same block, so a single-shot
`extract_semantic_dom_after` also reports what the page did.

**Secrets.** The server is the one party that knows which strings it typed. A `fill` into a
password field (detected at fill time) or one marked `secret: true` registers the value, and
every string in every result is scrubbed of it afterwards: node values after a "show password"
toggle, a status line that echoes the input, console messages, dialog text, error messages.
Values shorter than 8 characters are not scrubbed, since they would collide with ordinary page
copy. The set is process-wide (a secret typed in one session is scrubbed from every later result
in any session) and lasts until the server exits, which is why `secret: true` is for real secrets
only; a locator whose text was redacted is emitted with `is_unique: false` and a note, since the
emitted string can no longer match. Independently, the in-page engine never reports `value` for password fields or for
`autocomplete` tokens that mark credentials, one-time codes and card data.

**Diffs.** `session_extract({ diff_against })` pairs nodes across two snapshots by identity. The
resolved primary locator is deliberately *not* the identity: a hidden menu item resolves to
`getByText` (role locators skip hidden elements) and the same item, once visible, to
`getByRole`, and that transition is exactly what a test wants reported as a change. Identity is
computed inside the page from the element's own attributes, so it does not depend on which
locators were verified (verification stops early on unique nodes): a test attribute, else a
human-authored id, else a placeholder, else tag + role + accessible name; plus the frame path and
a document-order index so non-unique nodes (list rows) still pair up. Same key on both sides and different fields =
`changed`, with a `from`/`to` per field, including `primary_locator.playwright` so the agent
knows which expression is valid in which state; a key only on the new side = `added` (the toast,
the dialog, the next page's controls); only on the old side = `removed`, as a compact reference.
A node whose accessible name changed and carries no stable attribute appears as removed + added,
and the diff's notes say so. Untouched nodes are counted, not listed. On a 25-node form the diff
after a click is 2.9 KB against 29 KB for a full re-extraction. Bad `diff_against` ids are refused
before a snapshot is taken, so a refusal consumes nothing.

**Schema 1.2 state.** The diff is only as useful as the state it compares, so every node now
reports `value` (never for password fields), `aria_expanded`, `aria_selected`, `aria_invalid`,
`described_by` (the text of the elements `aria-describedby` references, where validation
messages live), `validation_message` (constraint validation, only when the field is invalid) and
`options` for `<select>`. Absent state is `null`, never `false`.

## 9. The consistency layer — conventions as a served artifact

The second half of the goal has nothing to do with parsing. The server ships the team's
test-writing rules as the `write_playwright_test` prompt and the `conventions://playwright`
resource: use only locators from the extraction, apply disambiguation, chain `frameLocator` per
`frame_path`, assert extracted state with web-first assertions, treat the JSON as a single
snapshot, scope accumulating UI, and stop rather than invent when something's missing. Because
the server injects these, they cannot drift the way written style guides do — and changing them
is a reviewable pull request.

## 10. Design principles, in one place

1. **Facts, not guesses.** The default output contains only what the DOM proves. Heuristics
   (click targets, live-region text borrowing) are opt-in or flagged, never silent.
2. **Flag, never hide.** Truncation, unreachable frames, closed shadow roots, ambiguity,
   demotions — everything surfaces in the output.
3. **Verify with the real engine.** Uniqueness comes from Playwright's `count()`, not from string
   heuristics.
4. **Capture-time semantics, stated honestly.** A snapshot is one moment; the tool says so in its
   own output.
5. **Zero egress, deny by default.** The only network activity is navigating the browser to the
   allowlisted target. No telemetry, no logging of page contents.
6. **Standards, not libraries.** Extraction reads ARIA roles, labels, and computed style — never
   framework internals — so it works on any stack. Framework knowledge appears in exactly one
   place: the generated-id demotion list, which exists to *protect* against framework churn.

## 11. Honest boundaries

- **Test logic is out of scope**, measured rather than claimed: in the first A/B run, the
  MCP-side iterations were always behavioral (a redirect target, a lazy modal), never locators.
  v0.5's `observed` block targets exactly those two; the next A/B run measures whether they drop
  to zero.
- **Observed requests are what the page made, filtered.** Only xhr/fetch/document/eventsource/
  websocket resources are listed and capped at 500 per snapshot interval; bodies and query strings are never
  captured, so a test can wait on a path and method, not on a payload.
- **Diff identity needs a stable fact.** A control whose accessible name changes between steps
  (a button flipping from "Save" to "Saving…") pairs up only through a test-id, id or placeholder;
  with none of those it appears as removed + added, not changed.
- **Popups are closed, not followed.** A flow that continues in a new window (SSO, OAuth) cannot
  be walked in a session; the popup's URL is recorded and the window closed. Playwright reports
  a popup only after its initial navigation committed, so that one request has already been made
  by the browser; the server issues none.
- **Closed shadow roots** created by declarative shadow DOM (parsed before scripts run) evade the
  instrumentation and appear only via heuristic.
- **Cross-origin iframes** are deliberately opaque even though CDP could technically reach them —
  a conservative choice, revisitable.
- **The click-target heuristic is a heuristic** — it will include the occasional decorative
  wrapper, which is why it's opt-in and flagged per node.
- **Token figures are payload sizes** (4 chars/token estimates with exact char counts published),
  not end-to-end session billing.

## 12. Where to go next

- [README](../README.md) — surface, quickstart, security posture
- [GUIDE](GUIDE.md) — per-client setup, auth, dynamic states, troubleshooting
- [benchmark/](../benchmark/README.md) — methodology, measured results, A/B protocol and findings
- [ROADMAP](ROADMAP.md) — shipped-by-version history and what's next
