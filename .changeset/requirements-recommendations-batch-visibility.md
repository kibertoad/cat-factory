---
'@cat-factory/agents': patch
'@cat-factory/orchestration': patch
'@cat-factory/app': minor
---

Requirements-review recommendations: batch, tighten, and surface what's awaited.

- The Requirement Writer now answers findings in CHUNKS (up to 4 per LLM call) instead of one
  call per finding, so a batch of N findings costs `ceil(N / 4)` calls rather than N. Shared
  grounding is still gathered once and progress still streams `ready / total` a chunk at a time;
  a failure is isolated to its chunk. Each finding keeps the same per-finding output budget the
  single-call path used (scaled by chunk size), and a batched response is routed back to its
  findings by the echoed itemId with a prompt-order fallback — so a response that drops the ids
  isn't discarded wholesale and the whole chunk force-reopened.
- The Writer prompt (`requirement-writer`, bumped to v2) now asks for precise, succinct
  recommendations — the concrete answer in a couple of sentences, cite sources briefly, no
  preamble or padding — instead of open-ended prose.
- The review window now shows a persistent "awaited recommendations" summary (how many the
  Writer is still generating and how many are waiting on the human) in the stats rail, and lets
  you request recommendations while a merged review is being reworked — not only in the initial
  `ready` state.
- The incorporated-requirements document can now be collapsed as a whole. It defaults to collapsed
  only in the pre-incorporation `ready` phase (so a long doc doesn't push the findings being worked
  through off-screen) and expanded in `merged`/`incorporated`, where the document itself is the
  thing to read; a manual collapse no longer leaks across a status change.
