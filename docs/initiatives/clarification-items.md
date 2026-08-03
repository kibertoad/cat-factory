# Shared clarification-item abstraction (requirements review ⇄ planning interview)

**Status:** in-progress · **Owner:** platform · **Started:** 2026-07-07

## Goal & rationale

The **requirements-review** window and the **initiative-planning interview** window ask a
human to resolve a list of prompts, and the per-item interaction is _conceptually identical_:

- **answer** the prompt (free text),
- mark it **not relevant** (dismiss), and reopen a dismissed one,
- ask the AI to **recommend** an answer, then use/accept the suggestion.

Today only requirements-review has dismiss + recommend; the planning window has a bare answer
textarea and duplicated window chrome. We want the planning questions to offer the SAME surface,
**reusing** the requirements elements rather than cloning them, while NOT force-merging the parts
that genuinely differ.

### What is shared vs. what stays per-feature

| Layer            | Shared (this initiative)                                                                                                             | Stays per-feature                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UI**           | one `ClarificationItem` component: prompt + answer textarea + Not-relevant + Recommend + suggestion display + dismissed/reopen state | the window shell, header, and lifecycle rail (incorporate/re-review vs continue/proceed)                                                                                                                  |
| **Vocabulary**   | the item-status vocabulary `open` / `answered` / `dismissed` / `recommend_requested`                                                 | requirements' `resolved`, `severity`, `category`; the initiative's `interview` round state                                                                                                                |
| **Gate/backend** | —                                                                                                                                    | `ReviewGateController` (incorporate-doc → re-review → cap) vs `InterviewGateController` (ask → continue/proceed → synthesize brief); the entities (`requirement_reviews` table vs `initiatives` JSON row) |

The two gates **compose** the shared item concept; they are not merged (their lifecycles and
outputs differ, so merging would break one). This mirrors how `useReviewStage` already unifies the
board-surfacing of requirements-review + clarity-review without merging the services.

## Target pattern

- **Contracts**: `initiativeQaSchema` gains `status` (`open`/`dismissed`; answered is derived
  from a non-empty `answer`, not a stored status) + `recommendation` (nullable). No DB migration:
  the initiative persists as a JSON `doc` blob (`decodeInitiativeRow`), so both facades pick up
  the new fields for free.
- **Pure logic** (`initiative.logic.ts`): `applyQuestionStatus` / `applyQuestionRecommendation`
  - `isPendingQuestion` so the interviewer, the window, and `allAnswered` agree that a
    **dismissed** question no longer blocks; `retainedQa` keeps dismissed questions across rounds.
- **Backend actions**: the planning window's non-resuming actions (dismiss/reopen/recommend)
  live on the initiative interview controller path (`executionService.initiativeInterview`),
  reusing `InitiativeInterviewService`'s model resolution for the recommend LLM call. `answer`,
  `continue`, `proceed` are unchanged. Recommend runs INLINE (a single short LLM call), unlike
  requirements' async batched Writer: the planning interviewer is already inline.
- **Frontend**: `components/common/ClarificationItem.vue` is the shared surface. The planning
  window renders it; the requirements window adopts it via the `badges`/`actions` slots +
  `canRecommend`/`requested` props (next slice). The `initiative` store gains `setQuestionStatus`
  / `recommendAnswer` / `recommending`; new `api/initiative.ts` methods back them.
- **Board**: the initiative card pulses (`board-pulse`) while the interview is `awaiting`, the
  same attention treatment a review gate gets on a task card.

## Per-item status checklist

| #   | Item                                                                                                                                                                  | Status | Notes                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Tracker doc                                                                                                                                                           | done   | this file                                                                                                                                                                                                                                                           |
| 2   | Contracts: qa `status`/`recommendation` + request schemas + routes                                                                                                    | done   | `initiativeQaStatusSchema` = `open`/`dismissed`; answered derived from `answer`                                                                                                                                                                                     |
| 3   | Logic: `applyQuestionStatus`/`applyQuestionRecommendation`/`isPendingQuestion`; interviewer prompt respects dismissed                                                 | done   | `retainedQa` keeps dismissed across rounds                                                                                                                                                                                                                          |
| 4   | Backend: controller `setQuestionStatus`/`recommendAnswer`; server routes                                                                                              | done   | recommend runs the interviewer inline                                                                                                                                                                                                                               |
| 5   | Facade parity check + orchestration tests                                                                                                                             | done   | JSON blob ⇒ NO repo/migration change on either runtime; 623 orchestration tests green                                                                                                                                                                               |
| 6a  | Frontend: shared `ClarificationItem.vue` (prompt + answer + not-relevant + recommend + inline suggestion; `badges`/`actions` slots, `canRecommend`/`requested` props) | done   | `components/common/ClarificationItem.vue`                                                                                                                                                                                                                           |
| 6b  | Adopt it in the **planning** window                                                                                                                                   | done   | `InitiativePlanningWindow.vue`                                                                                                                                                                                                                                      |
| 6c  | Adopt it in the **requirements-review** window                                                                                                                        | todo   | Deferred to its own slice: that window's batched/toggled recommend + separate recommendations section + `recommend_requested` state differ; adopt via the slots with the e2e suite (Linux/CI) as the safety net rather than a blind refactor of a 1096-line window. |
| 7   | Frontend: `initiative` store (`setQuestionStatus`/`recommendAnswer`/`recommending`) + api actions; board `board-pulse` while awaiting                                 | done   |                                                                                                                                                                                                                                                                     |
| 8   | i18n: `clarification.*` keys across all 10 locales                                                                                                                    | done   | parity gate green; real translations, no en placeholders                                                                                                                                                                                                            |
| 9   | Changeset + CI guards                                                                                                                                                 | done   |                                                                                                                                                                                                                                                                     |

## Conventions & gotchas carried between iterations

- **Don't merge the gates.** The review gate and interview gate have different lifecycles and
  outputs; only the item interaction + its UI are shared. Resist the temptation to unify the
  services.
- **No migration.** The initiative is a JSON `doc` blob and requirement items are a JSON column,
  so new item fields are free, but keep the D1 ⇄ Drizzle mappers untouched (nothing to change)
  and DON'T add a column.
- **Keep the interviewer prompt stable for the untouched paths.** `formSeeded` / preset steering
  logic is byte-sensitive; a dismissed question must be surfaced to the interviewer as "the
  stakeholder marked this not relevant: do not re-ask," without disturbing the existing prompt
  for initiatives with no dismissals.
- **Recommend is inline for planning, async for requirements**: do not drag requirements' batched
  Writer/placeholder machinery into the initiative; the shared piece is the _button + suggestion
  slot_, not the fill mechanism.
- **The `interview-gate` trait** (added in the sibling fix PR) marks the resumable interviewer
  kinds; reuse it rather than kind-ids for any new engine branch.
- **A resuming window must NOT key its body on the interview entity alone.** Continue/proceed are
  asynchronous: the HTTP call records the intent on the parked step and wakes the durable driver,
  which then runs the (slow) interviewer LLM, so the response carries the PRE-resume entity; same
  questions, same `awaiting` status. Rendered from the entity, the window is byte-identical before
  and after the click, and a submit whose only effect lands 30s later is indistinguishable from a
  dead button (it was reported as exactly that). Both windows fold their RUN's status in via the
  shared `interviewGatePhase` (`app/utils/interviewGate.ts`, the frontend dual of the backend
  `InterviewGateController` spine): a resumed run flips `blocked` → `running` and emits, so
  `awaiting` + `running` is precisely "a pass is in flight". Derive it from the run rather than a
  local in-flight flag: that survives a reload and cannot wedge, because a pass that dies takes
  the run to `failed` instead of spinning forever. `converged` outranks `failed` deliberately: a
  failure after the interview settled belongs to the step that failed, not to the interview.
- **A running run is not automatically a running INTERVIEW.** Neither gate leads its pipeline
  ( initiative planning explores the codebase first, document authoring researches and outlines
  first) so `running` covers minutes of container work before the human is asked anything.
  Reported as `working` the window claims a pass is chewing on answers that were never given, on
  exactly the long lead-ins worth explaining. `interviewGatePhase` therefore splits it with
  `interviewStepReached(run, kind)`: `preparing` (something earlier is running) vs `working` (the
  interviewer itself). The argument is REQUIRED, not optional: a caller that omitted it would
  silently get the misleading half. It degrades to `working` for an uncached run or a chain with no
  such step, because over-reporting "still preparing" would leave a genuinely parked interview
  looking dormant, which is the worse failure. The card/inspector affordance spans BOTH phases: it
  is the only route into the window while a run owns the block, so narrowing it to `working` would
  strand the human on a "Run planning" button for a run already running.
- **The two states the entity cannot express get a SHARED panel.** `components/common/
InterviewGateNotice.vue` renders the wait and the stopped-run notice for both windows (copy per
  feature, treatment shared): the same rule as `ClarificationItem`: reuse, don't clone.
- **Name the two controls by what they DO, not by "forward".** "Continue" vs "Proceed to
  plan"/"Proceed to draft" both read as "go on" and were reported as indistinguishable; the pair
  is now "Submit answers" (the interviewer may ask follow-ups) vs "Plan now" / "Draft now" (skip
  the rest and go). Same rule for a disabled control: both windows render the unanswered COUNT,
  because a primary button that is silently greyed out is itself a "nothing happened". Where a
  window also has an RBAC gate on those buttons (the doc one does), the RBAC reason outranks the
  draft gap: a member who cannot execute runs must not be told to finish answering.
- **A multi-round interview must render PENDING FIRST.** The planning interview accumulates:
  `applyInterviewQuestions` keeps the answered + dismissed digest and APPENDS the new round after
  it, so from round two the only questions the human can still act on sit at the bottom, below a
  wall of ones they already settled. `orderInterviewQuestions` (`app/utils/initiative.ts`) floats
  the pending ones up for the RENDER only: the stored `qa` order is what the interviewer prompt
  and the in-repo tracker digest read, so never reorder the entity. Requirements review has no
  equivalent need: `replaceForBlock` publishes a fresh item set per round rather than accumulating.
  Two things the ordering has to get right, both pinned by `utils/initiative.spec.ts` and the
  window's own snapshot comment: keep the interviewer's chronological order WITHIN each group, and
  re-snapshot the order per ROUND rather than deriving it live from the answers; live, a question
  jumps out from under the human the moment they blur its textarea, and everything below shifts up
  while they are reading down the list.
- **Requirements adoption (6c) uses the slots, not new coupling.** Put its recommend-toggle button
  in the `actions` slot, its severity/category badges in the `badges` slot, drive `requested` from
  `recommend_requested`, and leave its recommendations section OUTSIDE the component, so the
  shared component never learns requirements' batch mechanism.
