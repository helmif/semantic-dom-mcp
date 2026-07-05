# Benchmark results — semantic-dom-mcp vs raw DOM

_Generated 2026-07-05T06:26:09.385Z by `npm run bench`. Token counts are estimated at 4 chars/token; char counts are exact — re-tokenize with your model's tokenizer for precise figures._

## Context payload an agent must consume

| Page | Raw HTML | Cleaned HTML¹ | Semantic JSON | Reduction vs raw | Reduction vs cleaned |
| --- | ---: | ---: | ---: | ---: | ---: |
| E-commerce home (SPA) | 452,474 ch (~113,119 tok) | 199,905 ch (~49,976 tok) | 15,334 ch (~3,834 tok) | **96.6%** | **92.3%** |
| Product detail (SPA) | 485,470 ch (~121,368 tok) | 185,929 ch (~46,482 tok) | 37,895 ch (~9,474 tok) | **92.2%** | **79.6%** |

¹ Scripts, styles, svg, meta and whitespace stripped — the fairest manual alternative to pasting the DOM.

## Locator evidence (the accuracy layer)

| Page | Interactive nodes | Verified-unique primaries | Ambiguous + flagged with guidance | Ambiguous + UNFLAGGED |
| --- | ---: | ---: | ---: | ---: |
| E-commerce home (SPA) | 14 | 5 | 9 | 0 |
| Product detail (SPA) | 29 | 13 | 16 | 0 |

Every returned locator was match-counted by Playwright's own engine before being emitted. The UNFLAGGED column must always be 0 — a non-unique locator without guidance is the #1 cause of flaky tests.

## Consistency & speed

| Page | Two extractions identical (captured_at excluded) | Extraction time |
| --- | :---: | ---: |
| E-commerce home (SPA) | yes | 14.1s |
| Product detail (SPA) | yes | 6.3s |

Identical output for identical page state is what makes two engineers (or the same engineer on two days) start from the same facts. Any drift here comes from the page itself changing between runs, and would hit a raw-HTML workflow far harder.

## What this benchmark does NOT show

- **Test quality uplift.** Whether agents write better tests with Semantic JSON needs an A/B protocol with human grading — see benchmark/README.md.
- **Selector hallucination in the raw-HTML condition.** By construction the MCP path cannot invent selectors; the raw path can. Measure it via the A/B protocol.
