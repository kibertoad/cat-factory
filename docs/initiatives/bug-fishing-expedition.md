# Initiative: Bug fishing expedition (multi-angle hunt → triage → spawned fix tasks)

## Goal & rationale

Every defect flow the platform has starts from a REPORT. `bug-investigator` triages one,
`pl_bugfix` fixes one, `bug-hunt` picks one off a tracker board, the `ci` gate reacts to one
that already broke a build. Nothing looks for the defects nobody has hit yet, and those are the
ones that cost the most: they ship, they sit, and they surface as an incident rather than as a
ticket.

A **bug fishing expedition** is the missing shape. It is a read-only, multi-angle hunt through a
service's codebase for genuine logic gaps, real bugs, footguns and unhandled edge cases. It
changes nothing and opens no pull request; its deliverable is the catch, and a human decides
which findings become work. Each finding they MARK spawns its own bug-fix task, on its own
pipeline, linked back to the expedition that found it.

Two design decisions carry the feature, and both are about the same thing: an agent asked to
"find bugs" in a healthy codebase finds something, and the something is a style opinion dressed
as a defect.

- **Angles, not one pass.** The expedition runs the SAME read-only agent once per ANGLE
  (control flow, failure handling, boundaries, concurrency, lifecycle, contracts, footguns,
  requirements conformance). A pass told to find everything returns the shallow half of
  everything; a pass told to think only about concurrency reads the same files with a question
  that makes the race visible. Each angle is its own container dispatch with a fresh context,
  which is also why they are affordable: the reading of one angle never lands on another's
  transcript.
- **A stated finding bar.** The prompt spells out the test a candidate must pass before it is
  reported (point at the code, describe what actually happens, would fixing it change
  behaviour, has something else already handled it) and names the empty answer as a legitimate
  result. `confidence` exists for the same reason: a finding the agent is unsure of is useful
  when it says so and worse than nothing when it does not.

## Target pattern (the reference implementations this copies)

- **The phase LOOP** is the Ralph loop's shape: `RalphController.resolveRalphResult` re-arms one
  step and re-dispatches it rather than finishing, and the dispatch epoch
  (`dispatchEpochFor`) gives each pass a job id of its own. `BugFishingController` is the same
  machine with a phase list instead of an attempt budget.
- **The PARK + human triage** is the PR deep-review's shape: state on the step
  (`step.bugFishing`, the sibling of `step.prReview`), a completion interceptor that
  short-circuits `recordStepResult`, a dedicated result-view window, and a `RunDecisionSurfaces`
  entry per verb.
- **SPAWNING a linked task** is the initiative loop's: `blockRepository.insert` under the
  expedition's own parent frame, then a bound `ExecutionService.start`, with the block rolled
  back if the start fails. `Block.expeditionId` mirrors `Block.initiativeId` exactly, down to
  its index.
- **The per-dispatch BRIEF** is the Challenge Investigator's: folded in as a `priorOutputs`
  entry by the step handler, so the standing role prompt stays overridable by a workspace
  without losing the angle the pass is fishing.

## What shipped

| Layer         | What                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts     | `bugFishing.ts` (the angle catalog, findings, step state, the lenient agent output, the request bodies), `bug-fishing` task type + its two creation fields, `Block.expeditionId`, `bugFishingFixPipelineId` |
| Kernel        | `pl_bug_fishing` (a single `bug-fisher` step, `research` purpose, no tail), the `bug-fishing → pl_bug_fishing` type default, the input-gate exemption                                                       |
| Agents        | the `bug-fisher` kind (read-only `container-explore`, full base-branch clone) + `renderBugFishingPhaseBrief`                                                                                                |
| Orchestration | `bugFishing.logic.ts` (the pure reductions), `BugFishingController` (the phase loop, the park, triage, spawning), the step handler + completion interceptor + failed-pass branch                            |
| Server        | four workspace-scoped routes under `/executions/:executionId/bug-fishing`                                                                                                                                   |
| Runtimes      | `blocks.expedition_id` + `workspace_settings.bug_fishing_fix_pipeline_id`, D1 ⇄ Drizzle                                                                                                                     |
| Frontend      | the expedition window (phase rail, per-finding triage, pipeline override), the create-form angle picker, the board setting, the inbox card, 10 locales                                                      |
| Coverage      | `bugFishing.logic.test.ts` (23 cases) + a cross-runtime conformance suite (loop → park → spawn → finish; board default + per-batch override + both loud refusals)                                           |

## The rules that bit, and why each is what it is

- **The expedition state must survive `resetStepForRerun`.** The loop re-arms the SAME step for
  each angle, so anything the reset clears is thrown away between passes. `bugFishing` is
  preserved by omission there, exactly like `prReview` / `forkDecision`, and the conformance
  suite asserts the ACCUMULATION (two angles, four findings) rather than only the last pass.
- **Triage does not wait for the hunt.** `address` is accepted while later angles are still
  fishing. That is the whole reason the angles are separate dispatches: a human who reads the
  concurrency pass at minute six should be able to start its fix then, not after the
  requirements pass finishes at minute forty.
- **A failed angle costs only that angle.** The passes share nothing but the checkout, so a
  crashed one is settled as `failed` CARRYING ITS REASON and the expedition moves on. A phase
  that silently reported nothing is indistinguishable from one that honestly found nothing,
  which is the distinction the record has to keep.
- **A spawn that cannot happen fails LOUDLY.** The first cut swallowed a start failure into
  "the finding stays untriaged" and answered 200. That reports the request as done and leaves
  somebody waiting for a task that is never going to appear, so the failure propagates instead;
  findings spawned earlier in the batch are already persisted, and the refused finding keeps no
  spawn record, so it stays markable. Conformance drives both refusals (a pipeline that does not
  exist, and one that exists but cannot be started on a one-off task).
- **The input gate had to learn about it.** A bug-fishing task legitimately has no description:
  its input is the codebase. `description_missing` is BLOCKING, so every expedition would have
  parked at step 0 before ever dispatching. The exemption is its own set
  (`CODEBASE_INPUT_TASK_TYPES`) rather than a second member of the platform-authored one,
  because the two answer different questions: that one is about who wrote the description, this
  one about where the input lives.
- **A retired angle is NAMED.** Phase ids are a persisted closed vocabulary, so a run keeps
  coming back out of the store naming an angle a later build may not ship. Each recorded phase
  carries the title and goal it ran under, `describeBugFishingPhase` answers "retired", and
  `describeRecordedPhase` prefers the run's own record over the placeholder — the expedition
  genuinely fished that angle and is the better witness.

## Open decisions

- **D1: how many angles by default.** Today: all eight, which is eight container dispatches. The
  create form narrows it and a recurring schedule can pin a subset. If the cost proves wrong in
  practice the honest fix is a shipped SUBSET as the default (with the rest opt-in), not a
  cheaper prompt: the angle separation is what the feature is.
- **D2: cross-angle deduplication is prompt-only.** Each pass is briefed with the titles earlier
  passes reported and told not to repeat them. The platform does not merge duplicates, because
  it cannot tell a repeat from a second instance of the same class in different code without
  reading both. If duplicates prove common, the place to fix it is a final aggregation pass, not
  a similarity heuristic over titles.
- **D3: no automatic re-fishing after a fix lands.** A recurring schedule re-fishes on its
  cadence and re-reports what is still there; nothing links a merged fix back to the finding
  that caused it. That link would need the expedition to outlive its run, which is a table.

## Follow-ups (not in this slice)

- An e2e spec (create an expedition, watch a phase land live, mark a finding, see the spawned
  card appear) — the live push is exactly what only the assembled product shows.
- A board affordance on the spawned task's card naming the expedition it came from. The link is
  stored (`Block.expeditionId`) and the window walks it the other way; the card does not yet.
- A `pl_bug_fishing_deep` variant pinning a stronger model per angle, once there is evidence
  about which angles are worth the spend.
