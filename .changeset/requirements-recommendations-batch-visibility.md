---
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': minor
---

Requirements-review recommendations: batch, tighten, and surface what's awaited.

- The Requirement Writer now answers findings in CHUNKS (up to 4 per LLM call) instead of one
  call per finding, so a batch of N findings costs `ceil(N / 4)` calls rather than N. Shared
  grounding is still gathered once and progress still streams `ready / total` a chunk at a time;
  a failure is isolated to its chunk. The output budget scales with the chunk size (bounded).
- The Writer prompt (`requirement-writer`, bumped to v2) now asks for precise, succinct
  recommendations — the concrete answer in a couple of sentences, cite sources briefly, no
  preamble or padding — instead of open-ended prose.
- The review window now shows a persistent "awaited recommendations" summary (how many the
  Writer is still generating and how many are waiting on the human) in the stats rail, and lets
  you request recommendations while a merged review is being reworked — not only in the initial
  `ready` state.
- The incorporated-requirements document can now be collapsed as a whole (it defaults to
  collapsed while there are still findings/recommendations to act on) so a long doc no longer
  pushes the actionable items off-screen.
