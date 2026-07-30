---
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Raise the inline document-planning output caps: `doc-researcher` to 24000 and `doc-outliner` to
10000 (from the shared 5000 default), symmetrically in both runtime routing builders. Both kinds
return their whole deliverable as one reply, so the cap bounds the artifact rather than guarding
against a runaway — at 5000 a research brief truncates mid-answer and the run drafts from it.
Each keeps the cheap default model; only the budget changes, and `AGENT_MAX_OUTPUT_TOKENS` still
overrides.
