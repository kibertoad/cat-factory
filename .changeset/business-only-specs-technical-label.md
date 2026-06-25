---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
---

Business-only specs + an explicit `technical` task label.

**Business-only spec-writer + "no new specs" outcome.** The spec-writer now captures
ONLY business requirements. For a purely technical task (a refactor / non-functional /
internal change with no externally-observable behaviour) "no new specs" is a valid
outcome: the writer returns `{"noBusinessSpecs": true}`, the baseline spec is left
untouched (`specPostOp` commits nothing), and the new `AgentRunResult.noBusinessSpecs`
channel carries the determination. The spec-companion corroborates or disputes it via a
new optional `technicalCorroborated` verdict on `companionAssessmentSchema` (a disputed
"no specs" claim loops the writer back as before). The spec-writer prompts are updated
accordingly (no version bump — they are not under prompt-version control).

**Explicit `technical` label on a task.** Blocks gain an optional `technical` field
(`true`/`false`/unset), persisted on both runtimes (D1 column ⇄ Drizzle column + generated
migration; shared block mapper). A human sets it at creation (a "Technical task" checkbox)
or via a tri-state inspector toggle (unset / technical / business), and a human-set value
is NEVER overridden by the engine. Left unset, the engine infers it on spec-companion
convergence — `noBusinessSpecs` (writer) combined with `technicalCorroborated` (companion).
When a task is technical the implementer treats the task definition / incorporated
requirements as the primary source of truth and the committed specs as a regression-spotting
reference; the `build` prompt is bumped to v3 and carries the per-task signal.

Breaking: none for existing data (the new columns default to "not determined").
