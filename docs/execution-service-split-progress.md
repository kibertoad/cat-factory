# ExecutionService split — progress tracker

Refactoring candidate **#8** from [`docs/refactoring-candidates.md`](./refactoring-candidates.md):
split the 5,148-line `ExecutionService` god class into an engine-internal **StepHandler registry**
(driving `stepInstance`) plus the existing **StepCompletionResolver** seam (driving
`recordStepResult`). Full plan: `/root/.claude/plans/plan-the-largest-most-unified-stream.md`.

Incremental + behaviour-preserving: one step kind per phase, each kept green on the cross-runtime
conformance suite (both Cloudflare D1 and Node Postgres).

## Key decisions

- **StepHandler registry is engine-internal** (built-ins constructed in-engine, closing over `this`,
  mirroring `buildStepResolverRegistry`). NOT a public registration seam — `registerGate` /
  `registerStepResolver` remain the external extension story.
- **Registry lives in orchestration** (`modules/execution/step-handler-registry.ts`), not kernel:
  its outcome type `AdvanceResult` is orchestration-local and there's no external registrant to keep
  free of the orchestration dep. (`StepResolution.control`, a public seam type, still goes in kernel.)

## Status legend

⬜ not started · 🟡 in progress · ✅ done (conformance green) · ⏭️ deferred

## Phases

| #  | Phase                                                   | Status |
| -- | ------------------------------------------------------- | ------ |
| 0  | StepHandler registry scaffolding (fallthrough, no-op)   | ✅     |
| 1  | Deterministic one-shot steps (deployer/tracker + resolvers) | ⬜  |
| 2  | Artifact ingestion resolvers (blueprint/spec/writeback) | ⬜     |
| 3  | Verdict resolvers (tester/companion, `control` field)   | ⬜     |
| 4  | Decision/polling/companion gate step handlers           | ⬜     |
| 5  | Container-agent default handler + cleanup               | ⬜     |

## Phase 0 — scaffolding

**Goal:** wire the StepHandler dispatch into `stepInstance` with a single fallthrough handler that
delegates the entire current per-kind body unchanged. Zero behaviour change; the safety net every
later phase relies on.

Checklist:

- [x] `kernel/.../step-resolver-registry.ts`: add `control?: 'park' | 'loop' | 'advance'` to `StepResolution` (defined now, consumed from Phase 3).
- [x] New `orchestration/.../execution/step-handler-registry.ts`: `StepHandler` + `StepHandlerContext` types.
- [x] `ExecutionService`: `stepHandlerCache`, `buildStepHandlerRegistry()` (one fallthrough handler), `dispatchStepHandler()`, extract per-kind body into `runStepBody()`.
- [x] Conformance green on both runtimes.
- [x] Changeset for `@cat-factory/kernel` + `@cat-factory/orchestration`.

## Notes / running log

- **Phase 0 done.** Wired the registry with a single fallthrough handler; `stepInstance` now
  runs the preamble then `dispatchStepHandler` → `runStepBody` (the unchanged per-kind body).
  Verified green: **Cloudflare** conformance 126 ✓; **Node** execution conformance 40 ✓ +
  durable-execution (pg-boss) 1 ✓ + core/agents/misc/integration conformance 86 ✓; orchestration
  execution + registry unit tests 161 ✓. Pre-existing repo-wide `.test.ts` typecheck drift
  (`onMissingEstimate`, AI-SDK `LanguageModelV3` mismatch) is unrelated and present on the base
  branch — src builds clean.
