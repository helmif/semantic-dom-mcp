# Benchmarking semantic-dom-mcp

Two kinds of evidence matter here, and they need different instruments:

1. **Mechanical evidence** — payload size, locator correctness, determinism.
   A script can measure these. Run `npm run bench -- <url> [url ...]`; it
   writes [RESULTS.md](RESULTS.md). Current committed results were captured
   against a live production e-commerce SPA on 2026-07-04 (target anonymized;
   set `QA_BENCH_LABELS` to control the page labels in the report).
2. **Behavioral evidence** — do agents actually write better, more consistent
   tests? That requires an A/B experiment with humans grading output. The
   protocol is below; run it with your team and add the findings here.

## What `npm run bench` measures

| Dimension | Why it matters | How it's measured |
| --- | --- | --- |
| Context payload | Tokens are money and context-window space. Raw DOM often doesn't fit at all. | Chars of raw `page.content()` vs cleaned HTML (scripts/styles/svg stripped) vs the Semantic JSON. Tokens estimated at 4 chars/token. |
| Locator correctness | "Zero hallucination at the locator layer" is the core claim. | Every primary is match-counted by Playwright's engine; report unique count and verify **zero** unflagged ambiguity. |
| Determinism | Consistency across people requires identical input for identical page state. | Two back-to-back extractions compared byte-for-byte (timestamp excluded). |
| Speed | Extraction must be cheap enough to run before every test-writing session. | Wall time per extraction. |

## A/B protocol for behavioral evidence (run manually, ~1 hour with 2 engineers)

**Setup.** Pick 3 scenarios on staging (e.g. login validation, add-to-cart,
checkout happy path). For each scenario, run two agent sessions with the same
model and the same scenario prompt:

- **Condition A (without MCP):** paste the page's cleaned HTML into the chat
  and ask for a Playwright test.
- **Condition B (with MCP):** let the agent call `extract_semantic_dom` and
  use the `write_playwright_test` prompt.

**Grade each generated test** (reviewer should not know which condition):

| Metric | How to score |
| --- | --- |
| Selector validity | % of selectors in the test that resolve to ≥1 element on the real page (run it). |
| Selector uniqueness | % that resolve to exactly 1 element (strict-mode failures count against). |
| Invented elements | Count of selectors/ids/text that do not exist on the page at all. |
| Convention adherence | 1 point each: describe/test structure, Arrange-Act-Assert, web-first assertions, frame chaining where needed, state assertions (visible/disabled/required), no ambiguous locator without scoping, no invented data. Max 7. |
| Runs green? | Does the test pass unmodified? If not, minutes-to-green. |
| Cross-person consistency | Have 2 engineers do the same scenario independently in each condition; diff the two B tests vs the two A tests (locator choices, structure). |

Record model, date, page URL, and token usage per session (both conditions
consume tokens; B's extraction JSON is counted in its total — the RESULTS.md
payload table predicts most of the gap).

## Metrics worth collecting longitudinally (after adoption)

- **Flake rate**: CI failures caused by selector breakage per 100 runs,
  before vs after adoption.
- **Review time**: minutes per test PR (conventions should shrink it).
- **Selector churn**: how often merged tests need locator edits within 30
  days (verified-unique locators should lower it).
- **Onboarding**: time for a new QA engineer to produce a merged, green test.
