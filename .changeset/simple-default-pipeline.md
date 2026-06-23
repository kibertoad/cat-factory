---
'@cat-factory/kernel': minor
---

Add a "Simple" built-in pipeline (`pl_simple`) to the seeded catalog. It is the
leanest end-to-end build preset: `coder` (Implementer) → `reviewer` → `mocker`
→ `tester`, then the standard `conflicts` → `ci` → `merger` mergeability/CI/merge
tail — no design, spec or documentation phases. Every new workspace now seeds it
alongside the existing built-in pipelines.
