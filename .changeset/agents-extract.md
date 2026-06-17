---
'@cat-factory/agents': minor
'@cat-factory/kernel': patch
---

Extract `@cat-factory/agents` — agent catalog, routing, prompts, fragment library, and versioned prompt registry are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility. `REVIEW_SYSTEM_PROMPT` moves from `requirements.logic` into agents (its natural home); `renderTaskContext`/`TaskContextView` move into `@cat-factory/kernel` (pure, kernel-deps-only).
