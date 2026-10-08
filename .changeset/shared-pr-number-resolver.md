---
'@cat-factory/contracts': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': patch
---

`resolvePrNumber`, which reads the pull request a `review` task names from its `prNumber` or `prUrl`, moves to `@cat-factory/contracts` so the SPA's guided-review button and the dispatch read a task's target the same way. Breaking for internal consumers: `@cat-factory/agents` no longer exports it; import it from `@cat-factory/contracts`.
