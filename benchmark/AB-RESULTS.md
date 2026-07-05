# A/B results — first real-world run (2026-07-05)

An existing, hand-written Playwright suite for a production e-commerce
platform (dev environment, login feature of a seller dashboard) was compared
against a suite regenerated from semantic-dom-mcp extractions alone. The
subject team has a written conventions document (test-id first, XPath
banned) and a Page Object Model codebase. All identifying details are
anonymized; the target app uses Ant Design, and the patterns below are
common to most component libraries.

## Conditions

- **A (baseline):** the team's newest hand-written spec — 10 tests, page
  object with 16 locators, run as-is on its own runner and config.
- **B (MCP):** the same scenarios regenerated using ONLY locators from 4
  extractions (`extract_semantic_dom` for the login page,
  `extract_semantic_dom_after` for the error state, the post-login state,
  and the opened account menu), via `npx semantic-dom-mcp@0.3.0` over stdio.
  Expected message copy came from the scenario, per the conventions.

Same environment, same runner, same worker count, same day.

## Results

| Metric | A (hand-written) | B (MCP-generated) |
| --- | --- | --- |
| Pass rate | **7 / 10** | **8 / 8** |
| Locator-caused failures | 3 (brittle SVG-attribute CSS never matched; exact-copy toast text flaked — identical assertion passed in 1 of 3 uses) | 0 |
| Behavioral iterations needed | — (suite pre-existing) | 2 (post-logout redirect target; late-rendering welcome modal) — neither was a locator defect |
| Unflagged ambiguous locators | ≥1 (menu-item XPath matching *every* item in the menu, correct only by DOM order) | 0 (ambiguity is flagged with `.nth()` guidance by construction) |
| Convention adherence | 9 of 16 locators are XPath despite the team's own written XPath ban | Conventions injected at generation time; nothing to drift |
| Test-ids the app emits | Not used (hand-written XPath on visible text instead) | Surfaced automatically by extraction |
| New-tab URL verification | click + `waitForEvent('page')` choreography | one `toHaveAttribute('href', ...)` assertion (schema 1.1 href capture) |

## Token trace (condition B's full context cost)

| Input | Est. tokens |
| ---: | ---: |
| Extraction 1 — login page | ~2,832 |
| Extraction 2 — invalid-login error state | ~2,884 |
| Extraction 3 — post-login state | ~5,058 |
| Extraction 4 — opened account menu | ~5,439 |
| Conventions prompt | ~350 |
| **Total** | **~16,600** |

Feeding the same four page-states as stripped HTML would cost roughly
150,000–200,000 tokens (extrapolated from [RESULTS.md](RESULTS.md)'s measured
per-page sizes) — about **90% less context**, with uniqueness guarantees the
HTML path cannot provide.

## Fixes fed back into the tool (shipped as v0.3.1)

The run exposed three extraction-completeness gaps, each fixed
library-agnostically with a regression test mirroring the real pattern:

1. Empty `role=alert`/`status` live regions now borrow `text_content` from
   their enclosing container (many toast libraries render the message beside
   the live region).
2. Descendant `img[alt]` is used as the text equivalent — image-only links
   get semantic role locators instead of structural CSS.
3. `wait_selector_after` on `extract_semantic_dom_after` — deterministic
   post-action wait for late-rendering modals, replacing guessed `settle_ms`.

## Honest limitations of this run

- Generated and graded by the same operator, not blind — treat as a strong
  pilot, not a controlled study. The blind protocol in
  [README.md](README.md) remains the standard for the next run.
- One scenario family (login/logout) on one application.
- The 2 behavioral iterations in condition B confirm the tool's stated
  boundary: it eliminates hallucination at the **locator layer**; navigation
  behavior and timing knowledge still come from the engineer.
