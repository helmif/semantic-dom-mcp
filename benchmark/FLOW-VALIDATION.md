# v0.5 flow validation (2026-09-07)

Not an A/B run. The A/B protocol needs the subject team's staging app and a
hand-written suite to compare against; neither is available outside that
team. This run answers a narrower question before release: **does a test
written only from session outputs run green, and what does the tool get
wrong?** The fixture and every artifact are in [flow/](flow/).

## Setup

- `flow/app.mjs`: a fixture mirroring the first A/B subject (seller-dashboard
  login). Ant Design-style empty `role=alert` with the toast text in a
  sibling, `POST /api/auth/login` returning 401 then 200, redirect to
  `/dashboard`, a welcome dialog rendered 700 ms after landing, an account
  menu with `menuitem`s, logout redirecting to `/login`.
- `flow/drive.mjs`: an MCP client over stdio against `dist/index.js`, walking
  `session_open` → `session_extract` → `session_act` (wrong password) →
  diff → `session_act` (right password) → diff → `session_act` (close
  dialog, open menu) → diff → `session_act` (logout) → `session_close`.
- `flow/login.spec.ts`: two Playwright tests written from those outputs only,
  per `conventions://playwright`.
- `flow/summary.json`: the recorded facts and payload sizes.

## Result

| Metric | Value |
| --- | --- |
| Generated tests green, unmodified | 2 / 2 |
| Behavioral iterations needed | 0 (redirect targets and API paths came from `observed`) |
| Locator-caused failures | 0 |
| Context cost, whole flow (10 calls, 4 snapshots) | ~10,600 est. tokens |
| Same flow as 4 full extractions (first A/B trace) | ~16,600 est. tokens |
| Flow wall time inside the server | 2.2 s |

The two behavioral iterations from the first A/B run (post-logout redirect
target, late welcome modal) did not recur: the redirect was in
`observed.navigations`, and `wait_selector_after` on the dialog's close
button made the late modal deterministic.

## What the run found in the tool

Running the generated test is what exposed these; the Vitest suite had not.

1. **`is_visible` disagreed with Playwright.** The empty live region has
   width but zero height. The extractor called it visible; `toBeVisible()`
   failed. Root cause: three visibility rules (both dimensions zero,
   `opacity:0`, `aria-hidden`) that Playwright does not use. `is_visible` now
   follows Playwright's `computeBox` rule exactly.
2. **Diff identity broke on hidden → visible.** Hidden menu items resolve to
   `getByText` (role locators skip hidden elements), visible ones to
   `getByRole`, so the diff showed 3 removed + 3 added instead of 3 changed.
   Identity is now test-id → id → placeholder → tag + role + accessible name,
   and the locator switch is reported as a change.
3. **Short secrets collided with page copy.** The test password `salah` was
   scrubbed out of the toast text "Email atau kata sandi salah". Redaction
   now applies to values of 8+ characters only.
4. **A completed fetch aborted by navigation was marked failed.** The logout
   POST had `status: 200` and `failed: net::ERR_ABORTED`. A failure is now
   recorded only when no response arrived.

## Second run: a real dev environment (2026-09-08)

Same driver pattern against a real e-commerce seller platform's dev
environment (identifying details omitted), guest add-to-cart: home → settle →
product card → product page → "Tambah ke Keranjang" → diff. The listing
renders after a `GET /api/v1/seller/products` call, the product opens by
client-side navigation, and a guest click opens a login dialog.

| Metric | Value |
| --- | --- |
| Generated test green against the live dev site, unmodified | 1 / 1 |
| Behavioral facts taken from `observed` | listing API to await, product API to await, no navigation on click |
| Diff after the click | 11 added (the login dialog), 2 changed (buttons that stopped being unique), 0 removed; 13 added before 0.5.1 dropped the two focus sentinels |
| Home page after settle | 68 nodes, ~22,500 est. tokens |
| Whole flow (8 calls) | ~39,600 est. tokens |

Four tool fixes came out of it, shipped as 0.5.1: `.nth()` found by
containment for cards located by heading text (the first click had failed
under strict mode with "3 matches" and no index), cards named by heading,
focus-trap sentinels dropped, `getByLabel` for `aria-label`-only elements.

The home page number is the token problem in plain sight: about 330 tokens
per node, most of it nulls, indentation, redundant fallbacks and duplicated
text. Compact output is the v0.6 priority; see the roadmap.

## Third run: authenticated add-to-cart on the same dev environment (2026-09-08)

With a Playwright storageState from a real seller login (`QA_MCP_STORAGE_STATE`;
the file never enters the repo). Flow: product page → "Tambah ke Keranjang" →
variant dialog (a table: one quantity field per variant) → quantity 1 →
confirm → buyer picker (five identical "Pilih Pembeli Ini" buttons) → pick →
success dialog → cart page.

| Metric | Value |
| --- | --- |
| Generated test green against the live dev site, unmodified | 1 / 1 (first run, 4 s) |
| Behavioral facts from `observed` | product API to await, `POST …/batch-carts/products` → 200 to await, cart list API |
| State transitions from diffs | confirm button `is_disabled` true → false after entering a quantity; quantity `value` 0 → 1; dialogs added and removed per step |
| Whole flow (12 calls, 5 snapshots) | ~22,700 est. tokens |

What the run found in the tool, shipped as 0.7.0: nameless custom radios and
repeated quantity fields inside a table, five identical buyer buttons, and
cart checkboxes inside test-id containers all came out as structural CSS or
ambiguous. Scoped locators fix that: the quantity field is now
`getByRole('row', { name: 'Charizard' }).getByPlaceholder('0')`, verified
unique on the real table, and the generated test uses it. Controls in plain
`<div>` cards with no row, list item or test-id ancestor keep `.nth()`
guidance; there is nothing factual to scope them by.

## v0.8: outline first, on the same dev environment (2026-09-08)

Prompted by an external Codex Desktop benchmark that found 0.7.0's full
extraction 3.9x the size of the native accessibility tree on an admin
table page, with 55% of primaries ambiguous. Same three authenticated seller
pages as above, same session, same load-then-settled wait on both arms
(the raw arm previously ignored `QA_MCP_STORAGE_STATE`; fixed).

| Page | Aria snapshot (native tree) | Outline | Full extraction 0.7 → 0.8 | Full vs aria |
| --- | ---: | ---: | ---: | ---: |
| Seller home | 11,699 ch | 541 ch (−95%) | 45,807 → 26,922 ch | 2.3x |
| Product detail | 13,904 ch | 2,133 ch (−85%) | 47,448 → 33,931 ch | 2.4x |
| Batch cart | 2,595 ch | 458 ch (−82%) | 10,988 → 9,023 ch | 3.5x |

### The same guest add-to-cart flow, the 0.8 way

Six calls: session_open → outline → scoped listing (`roles: ["link"]`,
`max_output_chars`) → `goto` the product with the button extraction in the
same call → add-to-cart with the dialog diff in the same call →
`session_verify_locators` on the four locators the spec uses.

| Version | Flow cost |
| --- | ---: |
| 0.5 (full extraction per step) | ~39,200 est. tokens |
| 0.6 (compact wire) | ~18,300 est. tokens |
| **0.8 (outline first, scoped, act+extract)** | **~3,800 est. tokens** |

All four spec locators verified unique in-session. The outline of the home
page was 1,049 characters and included the product grid as a `list` region,
even though it is a `<div>` grid with no list semantics.

### What the authenticated run showed

On the authenticated variant dialog the structured table came back as
`Charizard: { "Harga Satuan": "Rp35.000 Rp45.000 22%", "Kuantitas": "0" }`,
the quantity field as
`getByRole('row', { name: 'Charizard' }).getByPlaceholder('0')`, and the
confirm button, which shares its text with a button on the page behind it, as
`locator('[role=dialog]').getByRole('button', { name: 'Tambah ke Keranjang' })`,
unique inside the dialog. Entering a quantity flipped the confirm button's
`is_disabled` from true to false in the diff, as expected.

Clicking that confirm button then produced no request and no page change on
this dev environment, across three different locator forms and on a second
product. The server reported exactly that: no error, no request, no diff.
The click reached the element (Playwright's actionability checks passed), so
this is application behaviour on that environment, not an extraction defect —
and "nothing happened" being visible in the output is the tool working.

A full-page extraction is still larger than the aria snapshot, by design:
it carries locators, verdicts and state that the tree does not. The way
to spend fewer tokens is to not ask for the whole page.

## v0.6 wire format: before and after on the same dev environment (2026-09-08)

Same pages, same flow, same day. Before = 0.5.1 (pretty-printed JSON, every
candidate verified). After = 0.6.0 (schema 1.3 wire rules, verification stops
at the first unique candidate). Token counts estimated at 4 chars/token.

| Payload | 0.5.1 | 0.6.0 | Change |
| --- | ---: | ---: | ---: |
| Home page, `extract_semantic_dom` (`npm run bench`, 10 nodes) | 12,385 ch | 5,236 ch | −58% |
| Product page, `extract_semantic_dom` (14 nodes) | 15,032 ch | 4,664 ch | −69% |
| Home page after settle, session snapshot with click targets (68 nodes) | ~22,600 tok | ~11,000 tok | −51% |
| Product page, session snapshot (36 nodes) | ~11,200 tok | ~4,900 tok | −56% |
| Diff after the add-to-cart click | ~4,100 tok | ~1,400 tok | −66% |
| Whole guest add-to-cart flow (8 calls) | ~39,200 tok | ~18,300 tok | −53% |

Locator output is unchanged: the same primaries, the same `is_unique`
verdicts, the same `.nth()` guidance; the diff after the click reports the
same 11 added and 2 changed nodes. Extraction wall time on these pages is
dominated by the `networkidle` wait (about 3 s home, 2 s product), so the
fewer verification round trips do not show here; they matter on pages with
hundreds of nodes.

## Reproduce

```bash
npm run build
node benchmark/flow/app.mjs &
node benchmark/flow/drive.mjs
```

To run `login.spec.ts`, install `@playwright/test@1.61.1` in a scratch
directory with a config whose `baseURL` is `http://127.0.0.1:4177`.
