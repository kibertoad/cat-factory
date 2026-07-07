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
**reusing** the requirements elements rather than cloning them — while NOT force-merging the parts
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

- **Contracts** — `initiativeQaSchema` gains `status` (`open`/`dismissed`; answered is derived
  from a non-empty `answer`, not a stored status) + `recommendation` (nullable). No DB migration:
  the initiative persists as a JSON `doc` blob (`decodeInitiativeRow`), so both facades pick up
  the new fields for free.
- **Pure logic** (`initiative.logic.ts`) — `applyQuestionStatus` / `applyQuestionRecommendation`
  - `isPendingQuestion` so the interviewer, the window, and `allAnswered` agree that a
    **dismissed** question no longer blocks; `retainedQa` keeps dismissed questions across rounds.
- **Backend actions** — the planning window's non-resuming actions (dismiss/reopen/recommend)
  live on the initiative interview controller path (`executionService.initiativeInterview`),
  reusing `InitiativeInterviewService`'s model resolution for the recommend LLM call. `answer`,
  `continue`, `proceed` are unchanged. Recommend runs INLINE (a single short LLM call), unlike
  requirements' async batched Writer — the planning interviewer is already inline.
- **Frontend** — `components/common/ClarificationItem.vue` is the shared surface. The planning
  window renders it; the requirements window adopts it via the `badges`/`actions` slots +
  `canRecommend`/`requested` props (next slice). The `initiative` store gains `setQuestionStatus`
  / `recommendAnswer` / `recommending`; new `api/initiative.ts` methods back them.
- **Board** — the initiative card pulses (`board-pulse`) while the interview is `awaiting`, the
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
  so new item fields are free — but keep the D1 ⇄ Drizzle mappers untouched (nothing to change)
  and DON'T add a column.
- **Keep the interviewer prompt stable for the untouched paths.** `formSeeded` / preset steering
  logic is byte-sensitive; a dismissed question must be surfaced to the interviewer as "the
  stakeholder marked this not relevant — do not re-ask," without disturbing the existing prompt
  for initiatives with no dismissals.
- **Recommend is inline for planning, async for requirements** — do not drag requirements' batched
  Writer/placeholder machinery into the initiative; the shared piece is the _button + suggestion
  slot_, not the fill mechanism.
- **The `interview-gate` trait** (added in the sibling fix PR) marks the resumable interviewer
  kinds; reuse it rather than kind-ids for any new engine branch.
- **Requirements adoption (6c) uses the slots, not new coupling.** Put its recommend-toggle button
  in the `actions` slot, its severity/category badges in the `badges` slot, drive `requested` from
  `recommend_requested`, and leave its recommendations section OUTSIDE the component — so the
  shared component never learns requirements' batch mechanism.
