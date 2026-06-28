---
"@cat-factory/orchestration": patch
"@cat-factory/kernel": patch
---

Begin splitting the `ExecutionService` god class (refactoring candidate #8). Phase 0:
introduce an engine-internal `StepHandler` registry that `stepInstance` dispatches to after
its fixed run-lifecycle preamble, with a single fallthrough handler delegating the entire
per-kind body unchanged (zero behaviour change — the safety net for the incremental,
conformance-gated migration that follows). Adds an optional `control` field to the kernel
`StepResolution` seam (consumed from a later phase; resolvers that omit it keep today's
advance-on-completion behaviour).
