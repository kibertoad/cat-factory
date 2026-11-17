# Initiative: Staged project definitions

**Status:** not started · **Owner:** orchestration · **Started:** 2026-11-17

Builds on [ADR 0069](../../backend/docs/adr/0069-projects-and-research-projects.md) (projects,
and research as their first kind). Read that first: this tracker only describes what changes.

## Goal & rationale

A project today runs one kind of work many times against one growing result: a research project's
tasks are all `research` tasks, folded into one findings view. Real solutioning work is a sequence
of different stages where each stage consumes what the earlier ones settled. The motivating shape
(kept org-side, never shipped) is building a vendor integration:

1. discovery research against the vendor;
2. a dialogue with a human that turns findings into a decision register;
3. a test rig written into the vendor's test space, only after a human approves the writes;
4. implementation spread over several service repositories;
5. hands-on verification against stated "done" criteria;
6. a knowledge document and handoff built from everything above.

The platform must be able to express that sequence, and any other one, as data in a project
definition. cat-factory ships **mechanisms only**: no vendor, no integration methodology, no
built-in definition of this shape. A definition without stages behaves exactly as today.

## Target pattern

- **Stages are envelope data.** A definition gains an optional `stages` list, owned by the
  platform like `credentials` and `targets`, so every kind gets stages without re-implementing
  them. A stage names the task type it runs, `after` (stages it waits on), `consumes` (upstream
  stage and stream), the stream it `produces`, `start: 'auto' | 'manual'`, an optional
  `checkpoint` (a human clears it before downstream stages unlock), `repeatable`, and optional
  `acceptance` criteria.
- **Stage state is derived, never a blob.** A stage is complete when its stream holds an outcome
  and its checkpoint, if any, is cleared. Outcomes are already immutable and sequence-ordered, so
  the only new persisted fact is the checkpoint clearance (one row per project, stage and cleared
  outcome). No rev-guarded document like the initiative entity.
- **Content lives in task handlers, not in one module per kind.** A handler is keyed by task
  type and owns its agent kind, outcome body schema and version, `planTask` / `brief` / `finish` /
  `parseOutcome` / `renderContext`. The kind module keeps only what is genuinely the kind's: spec
  validation and the project-level view. Research becomes the first handler, reusable as a stage
  in any kind.
- **Upstream results reach a stage the way linked projects reach a task**: rendered by the
  producing stream's handler, written to `.cat-context/`, and recorded on the step with the `seq`
  that was read, as `contextProjects` is today.
- **Projects still never write to a repository.** Repo work is a spawn stage that creates ordinary
  tasks in named linked services, with the project linked as context.

## Locked decisions

- **No branching on a kind or definition id in the engine.** Every deviation is stage data or a
  handler method, the same rule initiative presets follow.
- **A human clears a checkpoint; the engine never reads a verdict out of model prose.** Exit
  criteria are judged in code against stated evidence and shown at the checkpoint; the human
  decides.
- **Decisions are proposed by the model and settled by a human.** The decision stage never records
  a decision the human did not take.
- **A rerun upstream marks downstream stages stale**, stated in the view. It never silently reruns
  them and never leaves them looking current.
- **Spawn machinery is extracted from initiatives and shared**, not copied a third time.
- **Public API changes are additive** (new endpoints and optional fields only), per
  [ADR 0034](../../backend/docs/adr/0034-public-api-stability.md).

## Verified facts the slices start from

1. One kind has exactly one module, one `agentKind` and one `outcomeSchemaVersion`
   (`kernel/src/domain/project-kind-module.ts`). `ProjectKindModuleRegistry.register` refuses two
   kinds sharing an agent kind, and dispatch finds the module through `forAgentKind`
   (`ExecutionService`). A handler reused across kinds needs dispatch to resolve from the step's
   recorded `project` state instead.
2. `brief()` receives the project's outcomes decoded by the module's own `parseOutcome`, so today a
   task can only read outcomes of the body type its own kind writes.
3. `resolveRepoTarget` stops at a project root with `project_has_no_writable_repo`. ADR 0069 lists
   "which linked service an item writes to" as the open question that blocks repo work under a
   project.
4. The harness `http_request` tool (`executor-harness/src/project/access-tools-server.ts`) accepts
   any HTTP method. Only the origin is bounded by `targets`; "change nothing in the vendor account"
   is prompt text in `project-researcher`, not enforcement.
5. Initiatives already have phase checkpoints, just-in-time spawning and item reconciliation
   (`modules/initiative/InitiativeLoopService.ts`, `initiative.logic.ts`), and an interview on the
   park/signal spine (`InterviewGateController`), all tied to the initiative entity.
6. Human approvals go through `buildStepApproval`; rubric verdicts go through `JudgeRegistry`.

## Slices

Each slice lands on all three facades with its conformance assertion, and picks a mothership
bucket for every new repository method in the same PR.

- [ ] **1. Task handlers.** Split `ProjectKindModule` into a kind module plus per-task-type
      handlers; resolve dispatch from `step.project` (kind plus task type); per-handler body schema
      version. Research moves onto one handler with no behaviour change. Pure refactor.
- [ ] **2. Stages and derived state.** `stages` in the envelope with validation (acyclic `after`,
      `consumes` naming a produced stream, task types the kind offers); the checkpoint-clearance
      table (D1 migration and Drizzle schema); a pure `deriveStageState` over outcomes and
      clearances; auto-start of `auto` stages when their inputs settle; stale marking.
- [ ] **3. Upstream context.** A stage's consumed streams rendered by their handlers into
      `.cat-context/`; the read `seq` recorded on the step; a consumed stream that cannot be read
      breaks the run naming it.
- [ ] **4. Controlled vendor writes.** `targets[].access: 'read' | 'write'` and optional path
      scoping; the harness refuses non-GET/HEAD on a read target and anything outside the scope; a
      write stage parks for approval of its write plan through `buildStepApproval`. Bumps the
      runner image. Tightens research projects too, so it is worth landing early.
- [ ] **5. Decision stage.** A handler whose agent proposes items (question, recommended default,
      trade-off, evidence) and parks for the human to answer, accept, or dismiss each one; writes a
      `decisions` stream. Reuses the clarification-item vocabulary and component.
- [ ] **6. Spawn stage.** Extract the initiative spawn and reconcile logic into a shared service;
      a spawn stage creates tasks in the linked services it names, links the project, runs their
      normal pipelines, and completes when they settle.
- [ ] **7. Exit criteria.** Stage `acceptance` criteria judged through `JudgeRegistry` against the
      outcome and its evidence; each criterion reported met, unmet or unverified at the checkpoint.
- [ ] **8. Document stage.** A handler that composes upstream streams and their artifacts into one
      Markdown document with its referenced artifacts.
- [ ] **9. Surfaces.** The stage rail in the project takeover (status, stale, waiting on whom), a
      checkpoint notification, and additive public API routes to list stages, start one and clear
      a checkpoint, each with its `scripts/sdk/surface.mjs` entry. Website PR for the user-facing
      behaviour.

## Out of scope

- Choosing a model per stage. A stage picks its task type and so its pipeline; model selection
  stays wherever pipeline steps already take it.
- Live vendor demonstrations inside the decision dialogue. The decision stage works from findings.
- Publishing the document stage's output to an external wiki. That is a later delivery sink.

## Open questions

- Whether a stage's `produces` stream may be shared by a repeatable stage's reruns only, or by
  several stages. Starting position: one producing stage per stream.
- How a spawn stage handles a linked service that is unlinked while its tasks run.
