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

`page.goto(url, { waitUntil })` with `networkidle` as the default, because modern SPAs render
*after* the `load` event — extracting at `load` returns an empty application shell (a real
first-day failure that is now a self-explaining hint: a 0-node extraction tells you to try
`networkidle` or `wait_selector`). An optional `wait_selector` waits for a specific element,
which beats time-based waiting for slow dashboards.

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
- it has a non-default `tabindex` (a custom focusable control).

Everything else — layout wrappers, decorative divs — is excluded, keeping the output factual and
small. One documented exception exists because real listings demanded it: with
`include_click_targets: true` (default **off**), elements at a `cursor: pointer` **boundary**
(their parent chain isn't pointer — cursor is inherited, so this catches the card root, not its
thirty descendants) that carry content are included as heuristic nodes, each stamped with a
`context_note` saying so. That's the pattern JS-router product cards use: clickable, yet carrying
no anchor, role, or test-id.

### 5.3 Visibility — seven rules, resolved cheaply

`is_visible` is false if any of: `display:none` (self or ancestor), `visibility:hidden/collapse`,
`opacity:0` (self or ancestor), `hidden` attribute or `aria-hidden="true"` (self or ancestor),
a zero-size bounding box, or a null `offsetParent` while not `position:fixed`. Ancestor-dependent
rules would cost O(depth) per element if checked naively; instead the traversal **carries
inherited flags down the stack**, so each element is examined once. Hidden elements are still
*included* — tests assert hidden-ness all the time — just flagged.

### 5.4 Accessible name — what Playwright will call this element

Precedence: `aria-label` → `aria-labelledby` (resolved and joined) → an associated `<label>` →
the element's collapsed text → a descendant image's `alt` (how logo links get real names). Two
subtleties learned from real pages: ARIA `alert`/`status`/`dialog` roles never take their name
from contents, so their role locator is emitted bare (`getByRole('alert')`) unless an author name
exists; and when a notification live region is *empty* (many toast libraries render the message
in a sibling), the message text is pulled from the enclosing container and flagged — so the toast
copy is assertable.

### 5.5 What the engine emits: candidates, not strings

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
- Redundant brittle fallbacks are dropped when a unique semantic locator exists; counts are
  cached per frame and resolved in bounded parallel batches for speed.

This stage regularly *catches the tool's own mistakes*: when an emitted expression wouldn't
actually match (a name-from-content assumption on an `alert`, say), the count comes back 0 and
the candidate is demoted — honesty enforced by machinery rather than by care.

**One semantic worth engraving: uniqueness is verified *at capture time*.** A chat thread that
gains messages can turn a unique test-id into four matches an hour later. The conventions warn
agents to scope accumulating UI with `.first()`/`.filter()` for exactly this reason.

## 7. Assembly — the contract

Everything lands in one `SemanticExtract` JSON: `page_metadata` (title, final URL, timestamp,
node and frame counts, `truncated`, and human-readable `notes` carrying every warning the
pipeline generated) plus `interactive_nodes`. Properties that don't apply are `null`, never
omitted — a stable shape downstream. The schema is versioned (`1.1`) and frozen: additive changes
bump the minor, breaking changes would bump the major, and agents can rely on the shape.

Output size in practice: 92–97% smaller than the raw DOM of the same page, and byte-identical
across repeated runs of an unchanged page — which is what makes two engineers start from the same
facts.

## 8. Capturing what a snapshot can't see: `extract_semantic_dom_after`

A snapshot cannot contain the login-error toast, because that UI exists only *after* an
interaction — and the extractor must never improvise interactions. The resolution is **declared
actions**: the agent passes a bounded list (`fill`, `click`, `press`, `wait`; max 20) using
locator data from a prior extraction; the server performs them in the main frame and snapshots
the result. Deliberately *not* an arbitrary-script API — every action is schema-validated, fill
values are never logged or echoed into errors (they may be credentials), each action has a
timeout, and after the actions run the page's host is re-checked against the allowlist: if the
actions navigated somewhere non-allowlisted, nothing is extracted. For late-rendering UI,
`wait_selector_after` waits for a specific element instead of guessing a settle delay.

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

- **Test logic is out of scope** — measured, not just claimed: in real A/B runs, the MCP-side
  iterations were always behavioral (a redirect target, a lazy modal), never locators.
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
