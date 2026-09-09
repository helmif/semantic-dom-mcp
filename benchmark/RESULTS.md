# Benchmark results — semantic-dom-mcp vs raw DOM

_Generated 2026-09-09T03:49:17.738Z by `npm run bench`. Token counts are estimated at 4 chars/token; char counts are exact — re-tokenize with your model's tokenizer for precise figures._

## Context payload an agent must consume

| Page | Raw HTML | Cleaned HTML¹ | Aria snapshot² | Outline (v0.8) | Full Semantic JSON | Outline vs aria | Full vs cleaned |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| E-commerce home (SPA) | 499,360 ch (~124,840 tok) | 234,585 ch (~58,646 tok) | 13,663 ch (~3,416 tok) | 993 ch (~248 tok) | 24,596 ch (~6,149 tok) | **92.7%** | **89.5%** |
| Product detail (SPA) | 415,716 ch (~103,929 tok) | 140,521 ch (~35,130 tok) | 9,022 ch (~2,256 tok) | 1,206 ch (~302 tok) | 15,699 ch (~3,925 tok) | **86.6%** | **88.8%** |

¹ Scripts, styles, svg, meta and whitespace stripped — the fairest manual alternative to pasting the DOM.

² Playwright's `ariaSnapshot()` of `<body>`: the accessibility-tree representation native browser tools give an agent. It carries no locators, no state and no verification; the outline is the MCP's comparable first look, from which the agent scopes a full extraction to one region. Both arms use the same storageState and the same load-then-settled wait.

## Locator evidence (the accuracy layer)

| Page | Interactive nodes | Verified-unique primaries | Ambiguous + flagged with guidance | Ambiguous + UNFLAGGED |
| --- | ---: | ---: | ---: | ---: |
| E-commerce home (SPA) | 54 | 5 | 49 | 0 |
| Product detail (SPA) | 34 | 14 | 20 | 0 |

Every returned locator was match-counted by Playwright's own engine before being emitted. The UNFLAGGED column must always be 0 — a non-unique locator without guidance is the #1 cause of flaky tests.

## Consistency & speed

| Page | Two extractions identical (captured_at excluded) | Extraction time |
| --- | :---: | ---: |
| E-commerce home (SPA) | yes | 2.9s |
| Product detail (SPA) | yes | 2.0s |

Identical output for identical page state is what makes two engineers (or the same engineer on two days) start from the same facts. Any drift here comes from the page itself changing between runs, and would hit a raw-HTML workflow far harder.

## What this benchmark does NOT show

- **Test quality uplift.** Whether agents write better tests with Semantic JSON needs an A/B protocol with human grading — see benchmark/README.md.
- **Selector hallucination in the raw-HTML condition.** By construction the MCP path cannot invent selectors; the raw path can. Measure it via the A/B protocol.
- **What a whole flow costs.** These are single-page payloads. A flow works outline-first and scoped: see [FLOW-VALIDATION.md](FLOW-VALIDATION.md), where a six-call add-to-cart flow cost ~3,800 estimated tokens.

## Reading the table

The outline is the MCP's first look at a page and is **smaller than the native accessibility
tree** an agent's built-in browser tool would hand it. The full Semantic JSON is **larger** than
that tree, on purpose: it carries an executable, uniqueness-verified locator, state and
assertion data for every node, which the tree does not. Ask for the whole page when you need all
of it; otherwise take the outline and extract one region with `scope`.
