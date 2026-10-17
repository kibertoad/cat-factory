---
'@cat-factory/kernel': minor
'@cat-factory/spend': patch
---

Add Gemini 4 Argon and Meta Muse Wonder to the model catalog and the price table, retire the
superseded Gemini Flash entries, and raise the four gateway price rows that had fallen below their
route.

New catalog entries, both OpenRouter-only because no other route serves them yet:

- `gemini-4-argon` (Gemini 4 Argon, 2026-10-13, `google/gemini-4-argon`): Google's new flagship,
  1M window, image input. Its $2 / $10 per 1M launch price doubles on 2026-12-01, and the row is
  already priced at the doubled $4 / $20, so the budget gate is never short when it lapses.
- `muse-wonder` (Meta Muse Wonder, 2026-10-12, `meta/muse-wonder`): $4 / $20 per 1M, 1M window.

Removed: the `gemini-3.7-flash` and `gemini-flash` (3.6 Flash) catalog entries and their price
rows, since Google routes every 3.7 Flash request to 3.8 Flash, plus the price rows for the retired
`deepseek:deepseek-chat` and `qwen:qwen3-max`. A ref on any of them now meters at its provider's
bare fallback, which is dearer than the removed row. A block pinned to a removed catalog entry
needs a new pick.

Price corrections, all in the safe direction: `openrouter:google/gemini-3.8-flash` follows the
gateway's 10% Vertex surcharge (0.76 / 3.80 EUR per 1M), `openrouter:z-ai/glm-5.3` output moves
to 4.42, `openrouter:qwen/qwen3.7-max` output to 4.08, and `openrouter:deepseek/deepseek-v4-flash`
input to 0.084.
