# Initiative: Staged project definitions

**Status:** in progress · **Owner:** orchestration · **Started:** 2026-11-17

Builds on [ADR 0069](../../backend/docs/adr/0069-projects-and-research-projects.md) (projects,
and research as their first kind). Read that first: this tracker only describes what changes.

## Goal & rationale

A project today runs one kind of work many times against one growing result: a research project's
tasks are all `research` tasks, folded into one findings view. Real solutioning work is a sequence
of different stages where each stage consumes what the earlier ones settled. The motivating shape
(kept org-side, never shipped) is building a vendor integration:

1. discovery research against the vendor;
1. a dialogue with a human that turns findings into a decision register;
1. a test rig written into the vendor's test space, only after a human approves the writes;
1. implementation spread over several service repositories;
1. hands-on verification against stated "done" criteria;
1. a knowledge document and handoff built from everything above.

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

1. A handler's `brief()` receives only the outcomes its own stage (or, unstaged, its own task
   type) wrote; anything else a task reads arrives as context through `consumes` or a link.
2. `resolveRepoTarget` stops at a project root with `project_has_no_writable_repo`. ADR 0069 lists
   "which linked service an item writes to" as the open question that blocks repo work under a
   project.
3. Initiatives already have phase checkpoints, just-in-time spawning and item reconciliation
   (`modules/initiative/InitiativeLoopService.ts`, `initiative.logic.ts`), and an interview on the
   park/signal spine (`InterviewGateController`), all tied to the initiative entity.
4. Human approvals go through `buildStepApproval`; rubric verdicts go through `JudgeRegistry`.

## Slices

Each slice lands on all three facades with its conformance assertion, and picks a mothership
bucket for every new repository method in the same PR.

- [x] **1. Task handlers.** A kind module names the `ProjectTaskHandler`s its projects run; a
      handler owns its task type's agent kind, body schema and version, and may serve several
      kinds. Dispatch resolves the handler from the task's type under its project's kind, and each
      outcome row records `taskType` so readers decode it with that handler. Research moves onto
      one handler with no behaviour change. PR: [#2522](https://github.com/kibertoad/cat-factory/pull/2522)
- [x] **2a. Stages and derived state.** `stages` in the envelope (`project-stages.ts`), validated
      structurally (unique ids and streams, known and acyclic `after`, `consumes` within the
      ancestry) and per stage by its task type's handler (`parseConfig`); `project_stage_tasks`
      (D1 0119 and its Drizzle twin) binding a task to its stage, with a partial unique index as the
      one-open-task-per-stage claim; `deriveProjectStageStates` in contracts; the board view's
      `stages`; `POST .../stages/:stageId/tasks` and `POST .../stages/:stageId/checkpoint`. A staged
      task plans from its stage's config and history and writes its stage's stream. PR: [#2523](https://github.com/kibertoad/cat-factory/pull/2523)
- [x] **2b. Auto-start.** A stage with `start: 'auto'` creates and starts its task once it is
      ready: at project creation, after an outcome records, and after a checkpoint clears
      (`ProjectStageService.advance`, through a late-bound run starter). PR: [#2524](https://github.com/kibertoad/cat-factory/pull/2524)
- [x] **3. Upstream context.** A staged task reads each stage its stage `consumes`, up to exactly
      the result its stage task started from (`basis`), rendered by the writing handler's
      `renderContext` (research folds a stage's findings against that stage's questions) and
      scrubbed of secrets. The renderings ride the linked-project path (`.cat-context/` files and
      the prompt index, both now in every project job's body); the step records what it read in
      `step.project.upstream`; a consumed stage with no accepted result is stated, and one whose
      result cannot be read refuses the dispatch with `project_stage_upstream_unreadable`. PR: [#2525](https://github.com/kibertoad/cat-factory/pull/2525)
- [x] **4. Controlled vendor writes.** A target may declare `access: 'write'` and a `pathPrefix`;
      a stage may declare `writes`, and must then read only checkpointed stages (at least one),
      not be repeatable, and sit in a definition with a writable target; targets on one origin
      differ in prefix. The job body opens a writable target only to a writing stage's run,
      and the harness refuses any non-read method on a read target and any path outside a prefix
      (runner image 1.168.0). The browser is not bound: see `security-model.md`. PR: [#2526](https://github.com/kibertoad/cat-factory/pull/2526)
- [x] **5a. Checkpoint revision.** A handler may declare `checkpointRevision`: a person settles
      its result while accepting it at a stage checkpoint (`POST .../checkpoint` with a
      `revision`), optionally required. The platform writes the settled body as a new outcome on
      the stage's stream (intent `revise`, beside the model's proposal), and the checkpoint's
      atomic claim names it (`acceptedOutcomeId`): a revision no acceptance names counts for
      nothing, so a losing concurrent acceptance changes no result. PR: [#2527](https://github.com/kibertoad/cat-factory/pull/2527)
- [x] **5b. Decision stage.** The built-in `decisions` task type on `pl_decisions`: its
      `project-decider` agent proposes items (question, options, recommended default, rationale,
      evidence) from the stages it reads, and its handler requires every item settled at the
      checkpoint. Any kind lists the shipped `decisionTaskHandler` beside its own; the research
      kind does not. The stage rail renders the register (slice 9). PR: [#2528](https://github.com/kibertoad/cat-factory/pull/2528)
- [x] **6a. Staged linked context.** A task that links a staged project reads each stage's
      accepted result, rendered by its handler, in the definition's order; a stage with none yet
      is stated. Such a project is linkable once some stage has an accepted result, only those
      results' bodies are read, and the step records every accepted stage outcome as the
      revision. The kind's own project-level rendering stays for an unstaged project. PR:
      [#2529](https://github.com/kibertoad/cat-factory/pull/2529)
- [x] **6b. Spawn stage.** The built-in `spawn` task type on `pl_spawn`, whose one
      `project-spawner` step the engine performs itself: its handler declares
      `performedBy: 'engine'`, and the project step runs the engine task wired for the type, or
      refuses when none is. Its run creates a task in each linked service
      (title and description templated with `{service}`, task type, optional pipeline), links the
      project so each task reads the accepted stages, starts each run, and records what it
      created and every service it skipped. A handler may name the tasks its result awaits
      (`checkpointAwaits`): the checkpoint refuses with `project_stage_work_unsettled` until each
      is done or removed (a task moved to another board of the account is still awaited), which
      also makes its stage need a checkpoint. A handler may require its stage to run after
      another (`stageRequires.after`), as spawn does. The initiative loop and the spawner
      share `modules/spawn/spawnedTask.ts`. PR: [#2530](https://github.com/kibertoad/cat-factory/pull/2530)
- [x] **7. Exit criteria.** A stage may declare `acceptance` criteria. Once its task records a
      result, an inline assessor (the `StageAcceptanceAssessor` port, beside the judges'
      `JudgeAssessor`) argues each criterion: met or unmet, with passages quoted from the stage's
      rendered result as evidence. The platform computes the report: a criterion claimed met is
      `met` only when every quoted passage is in the result, `unverified` when it quotes none or
      a passage the result does not hold, and `unmet` as claimed; a criterion the reply leaves
      out is `unverified`. The report rides the stage-task record and the stage's state, shown
      at the checkpoint; a person still decides. An unwired assessor or a failed assessment is
      stated on the report, never read as a pass, and is replaced by the next attempt; a result
      with no report yet reads as `pending`. The judges' own prompt fixes a score-shaped
      reply over a clipped transcript, which cannot carry per-criterion claims, so the
      assessment shares their model resolution and credential scope but not their prompt. PR:
      [#2531](https://github.com/kibertoad/cat-factory/pull/2531)
- [x] **8. Document stage.** The built-in `writeup` task type on `pl_writeup`: its
      `project-writer` agent composes the results of the stages it reads into one Markdown
      document (title, summary, the document, the artifacts it references) against the stage's
      brief and outline. The platform names the outline sections the document has no heading
      for, drops (naming it) an artifact no result it read holds, keeps each artifact once and
      names those past the cap, and refuses a reply with no document written. A handler learns
      the artifacts it may reference through `ProjectTaskInput.upstreamArtifacts`, derived from
      the same rows the upstream rendering reads and only on a first dispatch; a writeup stage
      must read at least one stage (`stageRequires.consumes`). PR: [#2532](https://github.com/kibertoad/cat-factory/pull/2532)
- [x] **9a. Public stage routes.** `GET /api/v1/projects/{projectId}/stages`, `POST
      .../stages/{stageId}/tasks` (`write`) and `POST .../stages/{stageId}/checkpoint`
      (`decide`), each with its `scripts/sdk/surface.mjs` entry; the public outcome names its
      `taskType`, and a kind serves each task type's outcome schema (`schemas.outcomes`). PR:
      [#2533](https://github.com/kibertoad/cat-factory/pull/2533)
- [ ] **9b. Stage rail.** The stage rail in the project takeover (status, stale, waiting on
      whom, the acceptance report, starting a stage and accepting its checkpoint) and a
      checkpoint notification. Website PR for the user-facing behaviour.

## Out of scope

- Choosing a model per stage. A stage picks its task type and so its pipeline; model selection
  stays wherever pipeline steps already take it.
- Live vendor demonstrations inside the decision dialogue. The decision stage works from findings.
- Publishing the document stage's output to an external wiki. That is a later delivery sink.

## Gotchas

- A task type and an agent kind each name exactly one handler. Dispatch resolves the handler from
  the task's type under its project's kind and records the task type on the step; checkpointing
  and recording read it back from there, so all three agree on the handler.
- An outcome with no recorded task type (a deleted task the backfill could not attribute, or a
  node one build behind) is decoded by the kind's handler when the kind has exactly one. A kind
  with several handlers serves such a body as stored. The public outcome names its task type the
  same way, and `GET /api/v1/project-kinds/{kind}` serves each task type's body schema under
  `schemas.outcomes`; `schemas.outcome` is null for a kind with several.
- A kind's descriptor and its module list task types separately. A task type the descriptor offers
  with no handler in the module is refused at dispatch with `task_type_not_offered_by_project`.

- A staged project's task belongs to the stage that started it (`project_stage_tasks`). A task
  created under a staged project any other way is refused at dispatch with
  `project_task_has_no_stage`, so until the stage rail lands (slice 9) the stage routes are the
  only way to start one.
- A stage holds one task with no recorded outcome at a time (a partial unique index). A claim
  that loses frees the slot only when its holder can no longer finish: its task was deleted, or
  its outcome landed and the write freeing the stage did not. A read never writes.
- `stale` compares the upstream results a stage's accepted task STARTED from (`basis`, recorded
  when the stage task is created) with the upstream results accepted now, not outcome order: a
  result accepted at a checkpoint after the downstream task recorded still makes it stale.
- A definition that declares no stages hashes without the `stages` key, so pins taken before
  definitions carried stages stay valid.
- The research kind's project view folds only its unstaged `main` stream against the
  definition's topics. A staged project reads as linked context through its stages instead, each
  accepted result rendered by its handler against that stage's own questions, so the kind's
  project-level rendering never sees a staged project. A per-stage view on the board comes with
  the stage rail (slice 9). A staged definition of the research kind still carries the
  kind's top-level spec; a kind built for stages declares its own.

- A spawned task's id is derived from its stage task and service, so a replayed spawn run finds
  the tasks it made instead of making them twice. It asks after them per board with
  `BlockRepository.getMany`: a mothership node's `findByIds` refuses an id that resolves to no
  block, and a block id alone does not name one board (seeded frames share ids across boards), so
  a service's frame is matched through its owning service. A spawned task waits on its board
  for a person when its task type pins no pipeline, when it runs on an individual-usage model,
  or when its run fails to start; the result says which.
  A service unlinked from the project after the spawn ran keeps its task: the result still names
  it, and the checkpoint waits for it until it is done or a person removes it.

- An automatic stage is started by the engine with no person behind it, like an initiative's
  spawned task: its task is created under the unattributed editor and its run is started with no
  initiator. It starts ONCE, when it first becomes ready with no task of it yet; after that a
  person decides, so deleting its task stops it. A task it created whose run never started (the
  process died in between, or the start failed) has its run started by the next trigger. A run on
  an individual-usage model is never started unattended: the task waits on the board for a
  person, and the log says why. Each trigger is best-effort, so nothing undoes the outcome or
  checkpoint that made the stage ready.

## Open questions

- Whether a stage's `produces` stream may be shared by a repeatable stage's reruns only, or by
  several stages. Starting position: one producing stage per stream.
