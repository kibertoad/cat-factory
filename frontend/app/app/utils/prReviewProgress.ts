import type { PrReviewStepState, StepSubtasks } from '~/types/execution'

// Pure derivation of the PR deep-reviewer's `reviewing`-phase progress, factored out of
// `PrReviewWindow.vue` so it is unit-testable independently of the Vue component.
//
// When the reviewer maintains a per-slice todo list (`step.subtasks`) — one entry per cohesive
// chunk of the diff — the UI shows per-slice progress. But that list is NOT always present: the
// reviewer often reviews via parallel general-purpose subagents, which never write a parent-level
// TodoWrite plan, so `subtasks` stays empty for the whole review (ADR 0026 P2/D2.2). So an empty
// todo list is NOT proof the reviewer is "still slicing" — it only means no per-slice plan has
// been reported yet. We therefore surface a NEUTRAL "reviewing, planning slices" state and switch
// to per-slice status the moment a plan exists — the UI never asserts a specific "slicing" phase
// purely because the parent stream emitted no todo list.

/**
 * True while NO per-slice todo plan has been reported (`total <= 0`). This is a neutral
 * "no plan yet" signal — the reviewer may be grouping the diff OR reviewing via subagents that
 * don't write a parent plan — NOT an assertion that it is "still slicing" (see the note above).
 */
export function hasNoSlicePlan(subtasks: StepSubtasks | null | undefined): boolean {
  return (subtasks?.total ?? 0) <= 0
}

/** Chunk-review completion as an integer percent, clamped 0..100, for the progress bar. */
export function chunkReviewPercent(subtasks: StepSubtasks | null | undefined): number {
  const total = subtasks?.total ?? 0
  if (total <= 0) return 0
  const completed = subtasks?.completed ?? 0
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)))
}

/** Labels of the chunk(s) the reviewer is actively working through right now (for the callout). */
export function activeChunkLabels(subtasks: StepSubtasks | null | undefined): string[] {
  return subtasks?.items?.filter((i) => i.status === 'in_progress').map((i) => i.label) ?? []
}

/**
 * The at-a-glance phase of a `pr-reviewer` step, collapsing its `prReview.status` (+ the
 * has-a-plan signal from the todo list) into a single kind the board surfaces label without
 * re-deriving. `completed`/`total` carry the slice counts for the `reviewing` kind. The
 * `planning` kind is the NEUTRAL "reviewing, no per-slice plan reported yet" state (see
 * {@link hasNoSlicePlan}) — it deliberately does NOT claim a specific "slicing" phase, since an
 * empty todo list is the normal shape of a subagent-driven review, not proof of slicing.
 * Returns `null` for the terminal / passed-through states (`done`/`skipped`) and when there is
 * no live review — those have no in-flight phase to show.
 */
export type PrReviewPhaseKind =
  | 'planning'
  | 'reviewing'
  | 'awaiting'
  | 'challenging'
  | 'fixing'
  | 'posting'

export interface PrReviewPhase {
  kind: PrReviewPhaseKind
  /** Slices whose review is finished (0 while planning). */
  completed: number
  /** Total slices the reviewer grouped the diff into (0 while planning). */
  total: number
}

export function prReviewPhase(
  state: PrReviewStepState | null | undefined,
  subtasks: StepSubtasks | null | undefined,
): PrReviewPhase | null {
  const status = state?.status
  if (!status) return null
  const completed = subtasks?.completed ?? 0
  const total = subtasks?.total ?? 0
  switch (status) {
    case 'reviewing':
      // No per-slice plan reported yet ⇒ neutral "planning" (don't claim "slicing"); once a plan
      // exists, work through the chunks with live counts.
      return hasNoSlicePlan(subtasks)
        ? { kind: 'planning', completed: 0, total: 0 }
        : { kind: 'reviewing', completed, total }
    case 'awaiting_selection':
      return { kind: 'awaiting', completed, total }
    case 'challenging':
      return { kind: 'challenging', completed, total }
    case 'fixing':
      return { kind: 'fixing', completed, total }
    case 'posting':
      return { kind: 'posting', completed, total }
    default:
      // done / skipped — no live phase to surface.
      return null
  }
}
