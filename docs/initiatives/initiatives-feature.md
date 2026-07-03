# Initiatives — the long-running, multi-task work container

**Status:** in progress · **Started:** 2026-07-03

> Durable source of truth for the multi-PR Initiatives feature. Update the slice
> checklist at the end of each PR so a later iteration can pick the work up without
> re-deriving context.

## Goal & rationale

cat-factory orchestrates single tasks well (one block → one run → one PR), but has no
construct for a body of work too large for one task — a cross-cutting refactor, a
migration, a strangler conversion. **Initiatives** add that: an `initiative`-level board
block whose **Initiative Planning pipeline** (`pl_initiative`) interviews the user on
goals/constraints, analyses the codebase, drafts a multi-phase plan for approval, commits
a structured tracker to the repo, and then **executes the plan as a loop of ordinary
tasks** — sequenced/parallel per an agreed concurrency policy — until every tracker item
is resolved.

Locked product decisions:

- **New `initiative` block level** (a frame child, like a module); spawned tasks link
  back via `blocks.initiative_id` (epic-style membership, not containment).
- **Just-in-time task spawning** — the tracker is the source of truth; task blocks are
  created only when about to start.
- **No initiative-level pause gates** — spawned tasks run STANDARD pipelines (which carry
  their own human gates / merge presets). Which pipeline a task gets is chosen by matching
  its planner-authored estimate (complexity/risk/impact) against the initiative's ordered
  pipeline rules (OR across axes — `shouldRunGatedStep` semantics), falling back to
  `defaultPipelineId`.
- **DB row is the source of truth; the repo doc is a rendered projection.** The
  `initiatives` table carries the entity (rev-CAS single-writer); the committed
  `docs/initiatives/<slug>/{initiative.json,tracker.md,version.json}` mirror follows the
  blueprint artifact pattern (canonical JSON + sha256 + version manifest +
  hash-short-circuited idempotent commits).

## Target pattern (reference implementation: slice 1, PR TBD)

- **Contracts**: `backend/packages/contracts/src/initiative.ts` (entity + plan-draft
  schemas, path helpers, strict parsers) + the `initiative` WorkspaceEvent + the
  snapshot's optional `initiatives` field + the `initiative-tracker` result view id.
- **Kernel**: `InitiativeRepository` port (rev-guarded `compareAndSwap`),
  `pl_initiative` in `seedPipelines()`, the kind constants + `hasInitiativeKinds` in
  `domain/initiative-logic.ts`, the `initiativeChanged` publisher hook.
- **Engine**: `InitiativeService` (create / ingestPlan / markExecuting over a CAS
  `mutate` loop) in `orchestration/src/modules/initiative/`; the bidirectional
  pipeline ⇔ block-level guard in `ExecutionService.assertRunnable`
  (`assertInitiativeShapeAllowed`); the planner's post-completion ingest resolver + the
  committer's deterministic step handler in `RunDispatcher`; `finalizeBlock` leaves an
  initiative block `in_progress` after planning (the loop owns terminal).
- **Agents**: `initiative-planner` = a migrated BUILT-IN container-explore kind
  (`buildMigratedBuiltInBody` case, structured output coerced into
  `AgentRunResult.initiativePlan` by `toRunResult`); the render/commit helpers in
  `agents/src/repo-ops/initiative.ts` (`coerceInitiativePlan`, `renderInitiativeFiles`,
  `commitInitiativeTracker`).
- **Persistence**: D1 migration `0035_initiatives.sql` ⇄ Drizzle `initiatives` pgTable
  (+ `blocks.initiative_id` in the shared mapper), repos in both facades, asserted by
  `conformance/src/initiative-suite.ts` (run by both runtimes' specs).
- **Frontend**: `stores/initiative.ts` (hydrate/upsert monotonic by `rev`),
  `CreateInitiativeModal` + the `frame-add-initiative` button, `InitiativeCard`,
  `InitiativeInspector`, `InitiativeTrackerWindow` (registered as `initiative-tracker`),
  `initiative.*` i18n namespace in all 8 locales.

## Slice checklist

| Slice                                                                                                                                                                                                                                                                             | Scope                                                        | Status  | PR        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------- | --------- |
| 1. Foundation: contracts + persistence + block level + planning-pipeline skeleton (`planner` → gate → `committer`) + Create Initiative button + read-only tracker window                                                                                                          | contracts/kernel/agents/orchestration/server/worker/node/app | ✅ done | (this PR) |
| 2. Interactive planning: `initiative-interviewer` park/answer/resume loop (model: `ReviewGateController`), `initiative-analyst`, planning window Q&A UI, statuses `planning → awaiting_approval → executing`                                                                      | engine + server + app                                        | ⬜ todo | —         |
| 3. Execution loop: `InitiativeLoopService` (tick + `runDue` in BOTH cron seams + terminal pokes in `RunStateMachine.emitInstance` / `mergePr`), JIT spawning with estimate→pipeline rules, reconcile + PR links + tracker re-commit, pause/cancel, `initiative` notification type | engine + both runtimes + app                                 | ⬜ todo | —         |
| 4. Follow-ups & polish: harvest child-run follow-ups + failure deviations into the tracker, promote-to-item, policy/item editing in the inspector, docs                                                                                                                           | engine + app                                                 | ⬜ todo | —         |

## Conventions & gotchas carried between iterations

- **Replay safety is load-bearing.** The planner ingest and the committer both run inside
  the engine's completion path, which a durable driver can REPLAY: `ingestPlan` is
  content-idempotent (`applyPlanDraft` preserves per-item runtime state and keeps decision
  timestamps stable), and `commitInitiativeTracker` hash-short-circuits. Keep any new
  writer on this discipline.
- **The tracker hash excludes `rev`/`updatedAt`/`doc`** (`initiativeContentView`) — hashing
  bookkeeping would make every DB write look like a content change and defeat the
  no-change commit short-circuit.
- **One live writer via `rev` CAS.** Every post-insert write goes through
  `InitiativeService.mutate` (read → transform → compareAndSwap, bounded retries). The
  slice-3 loop must keep tick-writes on this path; never write the repo mirror before the
  DB CAS wins.
- **Keep the runtimes symmetric**: the D1 ⇄ Drizzle pair, both block-repo mappings, both
  event publishers — and in slice 3, BOTH cron seams (`cloudflare/src/index.ts` scheduled
  - the Node interval next to `runtimes/node/src/recurring.ts`) — must land together with
    conformance assertions.
- **`assertRunnable` owns the pipeline ⇔ level restriction** (start/retry/restart all go
  through it); don't add a second guard at a single entry point.
- **The committer is a STEP HANDLER, not a postOp** — it needs the DB entity, which a
  `RepoOp` context doesn't carry. The planner's plan travels via
  `AgentRunResult.initiativePlan` (kind-aware coercion in `toRunResult`), NOT via
  `result.custom`.
- **Naming**: the SPA already has a `tracker` store/type/agent-kind (the ISSUE-tracker
  selection) — everything initiative-side is `initiative*`-prefixed.
- **Slice-3 loop rules** (agreed in planning): batch the reconcile reads (`listByIds` —
  no N+1); a `ConflictError` from `assertWithinTaskLimit` leaves an item `pending` for
  the next sweep (never `blocked`); never set `autoStartDependents` on spawned blocks
  (the loop owns sequencing); validate `defaultPipelineId` at ingest and record a
  deviation + notification (never throw inside the sweep) for a deleted pipeline.
- **Slice-2 extends `pl_initiative`'s `agentKinds` in place** (pre-1.0: no compat shim;
  bump the pipeline's catalog `version` so workspaces get the reseed offer).

## Out of scope

- Cross-repo initiatives (an initiative spans ONE service frame / repo for now).
- Deleting an initiative block does not yet cascade the entity row (slice 4).
- Editing the plan mid-flight from the UI (slice 4); re-running `pl_initiative` re-plans.
