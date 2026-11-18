# ADR 0070: Staged project definitions

- **Status:** Accepted (implemented)
- **Date:** 2026-11-18
- **Context layer:** `@cat-factory/contracts` (`project-stages.ts`, `stage-acceptance.ts`,
  `decisions.ts`, `spawn.ts`, `writeup.ts`, `public-projects.ts`), `@cat-factory/kernel`
  (`ProjectTaskHandler` and the kind module registry, `decisionTaskHandler`, `spawnTaskHandler`,
  `writeupTaskHandler`, the stage-task methods of `ProjectRecordRepository`,
  `BlockRepository.getMany`, `StageAcceptanceAssessor`), `@cat-factory/orchestration`
  (`modules/projects/`: `ProjectStageService`, `stageUpstream.ts`, `stageRevision.ts`,
  `stageAwaits.ts`, `stageSpawner.ts`, `stageAcceptance.ts`, `stagedProjectContext.ts`;
  `modules/spawn/spawnedTask.ts`), `@cat-factory/agents` (`project-decider`, `project-writer`, the
  acceptance prompt), `@cat-factory/server` (the project stage routes, internal and public), the
  executor harness's target access tools, both runtime facades, and `frontend/app`
  (`ProjectStageRail.vue`, `ProjectStageDecisions.vue`). Builds on
  [ADR 0069](./0069-projects-and-research-projects.md). Product pages, not yet live: the guide
  "Work Through a Staged Project" and the public API page's "Staged projects" section, in
  [kibertoad/cat-factory-website#128](https://github.com/kibertoad/cat-factory-website/pull/128).

## Context

A project, as ADR 0069 introduced it, runs one kind of work many times against one growing
result: a research project's tasks are all `research` tasks, folded into one findings view. Real
solutioning work is a sequence of different stages, each building on what the earlier ones
settled. The motivating shape, kept in a deployment and never shipped, is building a vendor
integration: discovery research, a dialogue that turns findings into decisions, a test rig written
into the vendor's test space once a person approves the writes, implementation across several
service repositories, verification against stated criteria, and a handoff document.

The platform has to express that sequence, and any other, as data in a project definition, and
ship mechanisms only: no vendor, no methodology, no built-in definition of that shape.

## Decision

**Stages are envelope data.** A project definition may declare `stages`, owned by the platform like
`credentials` and `targets`, so every kind gets them. A stage names the task type it runs, the
stages it runs `after`, the stages whose results it `consumes`, the stream it `produces`, whether
it starts on its own (`start: 'auto'`) or by a person, whether a person accepts its result at a
`checkpoint`, whether it is `repeatable`, whether its runs may write to a vendor (`writes`), its
`acceptance` criteria, and its task type's `config`. Validation is structural (unique ids and
streams, known and acyclic `after`, `consumes` within the ancestry and never repeated; a stage with
criteria declares a checkpoint; a writing stage reads at least one stage and only checkpointed
ones, is not repeatable, and sits in a definition with a writable target; two targets on one
origin differ in path prefix) and per stage by its task type's handler: its `config`, a checkpoint
where the handler requires a revision or awaits tasks, and `stageRequires` (a spawn stage runs
after another, a writeup reads at least one). A definition with no stages hashes without the
`stages` key, so a pin taken on a definition without stages stays valid.

**Content lives in task handlers.** A kind module lists `ProjectTaskHandler`s, one per task type:
the agent kind it dispatches (or `performedBy: 'engine'`), its outcome body schema and version,
planning, briefing, finishing, decoding and rendering its result for another reader. A handler may
serve several kinds. Each outcome row records the task type that wrote it, so a reader decodes it
with the right handler. Research is one handler; the platform also ships `decisionTaskHandler`,
`spawnTaskHandler` and `writeupTaskHandler`, which any kind lists beside its own.

**Stage state is derived, never stored.** `deriveProjectStageStates` computes each stage's status
(`blocked`, `ready`, `in-progress`, `awaiting-checkpoint`, `done`), its newest and accepted result,
what it waits on, and whether it is `stale`, from the project's outcomes and the
`project_stage_tasks` records. A record binds a task to its stage, holds the upstream results it
started from (`basis`), and records the checkpoint acceptance (`clearedAt`, `clearedBy`, and the
`acceptedOutcomeId` it names). A partial unique index is the claim that a stage holds one task
without a result at a time.

**Earlier stages feed later ones as context.** A staged task reads each stage it `consumes`, up to
exactly the result it started from, rendered by the handler that wrote it and delivered the way a
linked project's result is (`.cat-context/` files and the prompt index). The step records what it
read. A task that links a staged project reads each stage's accepted result in the definition's
order.

**A person settles at the checkpoint.** A handler may declare `checkpointRevision`: the person's
settlement (a decision register's choices) is written as a new outcome beside the model's proposal,
and counts only once the acceptance's atomic claim names it. A handler may name the tasks its
result awaits (`checkpointAwaits`), and the checkpoint refuses until each is done or removed. A
stage's `acceptance` criteria are argued by an inline assessment with quoted evidence, and the
platform computes each criterion's status from the quotes; the report is shown at the checkpoint
and decides nothing.

**The built-in stage kinds.** `decisions` proposes a register a person settles. `spawn` is performed
by the engine: it creates a task in each linked service with the project linked, starts each run,
and records what it created; ids are derived from the stage task and service, so a replay finds its
own tasks. `writeup` composes the stages it reads into one Markdown document, and the platform names
the outline sections it lacks and drops an artifact no result it read holds.

**Vendor writes are opt-in per stage.** A target may allow writes under a path prefix, and only a
writing stage's run is given it. A writing stage reads only stages a person accepted at a
checkpoint, and is not repeatable, so every write follows a person's acceptance. The bound is the
harness's `http_request` tool, so it holds on runner image 1.168.0 and later; it does not bind the
browser, through which a run can still submit a form on a `ui` target. See
[`security-model.md`](../security-model.md).

**Surfaces.** The project takeover opens a staged project on its Stages tab, where a person starts a
stage and accepts a result. A `stage_checkpoint` notification tells them a result awaits acceptance
and opens the project on its stages; it is raised from the derived stage state, so a replay raises
it again safely, and it stays out of review debt, which would refuse an automatic stage's start.
The public API lists stages, starts one (`write`) and accepts one (`decide`); an outcome names its
`taskType`, and a kind serves each task type's body schema under `schemas.outcomes`.

## Rationale

- **No branching on a kind or definition in the engine.** Every difference between stages is stage
  data or a handler method, the rule initiative presets follow, so a deployment's own stage kinds
  ride the same seams as the built-in ones.
- **The model proposes, a person decides.** A checkpoint is cleared by a person; the engine never
  reads a verdict out of model prose. Decisions are settled by a person, and a criterion counts
  as met only when every passage the model quoted for it is in the result; the report informs
  the person and accepts nothing.
- **Derived state cannot drift.** Outcomes are immutable and sequence-ordered, so the only new
  facts are which task belongs to which stage and who accepted what. A status computed on read
  cannot disagree with the outcomes it summarises, and nothing needs a rev-guarded document.
- **A rerun upstream is stated, never acted on.** `stale` says an accepted upstream result changed
  since a stage started; nothing reruns on its own and nothing looks current when it is not.
- **Spawning is shared, not copied.** The initiative loop and the spawn stage share linking and
  rollback (`modules/spawn/spawnedTask.ts`); task creation stays the one board funnel every door
  uses.
- **The acceptance assessment is not a judge.** The judges' prompt fixes a score-shaped reply over
  a clipped transcript, which cannot carry per-criterion claims with quotes. The assessment shares
  the judges' model resolution and credential scope through `runInlineJsonAssessment`.

## Consequences

- A task type and an agent kind each name exactly one handler. Dispatch resolves the handler from
  the task's type under its project's kind and records the task type on the step, so
  checkpointing and recording read back the same handler. A kind's descriptor and its module list
  task types separately: a task type the descriptor offers with no handler in the module is
  refused at dispatch with `task_type_not_offered_by_project`.
- The research kind's project-level view folds only its unstaged `main` stream, so a staged
  research project shows no findings there; its stages show them. A staged definition of the
  research kind still carries the kind's top-level spec; a kind built for stages declares its own.
- A staged project's task belongs to the stage that started it. A task created under a staged
  project any other way is refused at dispatch with `project_task_has_no_stage`.
- A stage's slot is freed after a lost claim only when its holder can no longer finish (its task
  was deleted, or its outcome landed and the write freeing the stage did not). A read never
  writes.
- `stale` compares the upstream results a stage's accepted task started from with the ones accepted
  now, so a result accepted after the downstream task recorded still makes it stale.
- An automatic stage starts once, when it first becomes ready with no task of it yet; after that a
  person decides, so deleting its task stops it. A task it created whose run never started (the
  process died in between, or the start failed) has its run started by the next trigger. Its run
  is started with no initiator, and a run on an individual-usage model waits on the board for a
  person. Each trigger is best-effort, so nothing undoes the outcome or checkpoint that made the
  stage ready.
- A staged project is linkable once some stage has an accepted result, and a link reads only those
  results' bodies. A project pinned to a definition the deployment cannot resolve is stated rather
  than rendered.
- A spawned task asks after itself per board (`BlockRepository.getMany`), because a mothership
  node's by-id read refuses an id that resolves to no block, and a service's frame is matched
  through its owning service, because a block id alone does not name one board. A spawned task
  waits on its board for a person when its task type pins no pipeline, when it runs on an
  individual-usage model, or when its run fails to start, and the result says which. A task moved
  to another board of the account, or left behind by a service unlinked after the spawn ran, is
  still awaited at the checkpoint until it is done or removed.
- An acceptance report that assessed nothing (no model, a failed call) says so and is replaced by
  the next attempt; a result not yet assessed reads as `pending`.
- An outcome with no recorded task type is decoded by the kind's handler when the kind has exactly
  one; a kind with several serves such a body as stored. `schemas.outcome` stays null for a kind
  with several task types.
- A new engine-only step kind (`project-spawner`) is declared as a system kind in the SPA catalog,
  or the pipeline-health check flags its built-in pipeline.
- Not covered: choosing a model per stage (a stage picks its task type and so its pipeline), live
  vendor demonstrations inside the decision stage, and publishing a writeup to an external wiki.
  Whether a stage's stream may be shared by several stages is open; today each stream has one
  producing stage.
