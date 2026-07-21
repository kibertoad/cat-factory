import type { PrReviewStepState, StepSubtasks } from '~/types/execution'

// Pure derivation of the PR deep-reviewer's `reviewing`-phase progress, factored out of
// `PrReviewWindow.vue` so it is unit-testable independently of the Vue component.
//
// The reviewer maintains a per-slice todo list (`step.subtasks`) once it has grouped the diff
// into cohesive chunks. The PRESENCE of that list is the signal that slicing is done, so the two
// `reviewing` sub-phases are told apart by it:
//   - no todo list yet (`total === 0`) → still SLICING the diff into chunks (no plan committed).
//   - todo list present (`total > 0`) → slicing DONE, working through the chunks.

/** True while the reviewer is still grouping the diff into chunks (it has not committed a plan). */
export function isSlicingChunks(subtasks: StepSubtasks | null | undefined): boolean {
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
 * slicing-vs-reviewing signal from the todo list) into a single kind the board surfaces label
 * without re-deriving. `completed`/`total` carry the slice counts for the `reviewing` kind.
 * Returns `null` for the terminal / passed-through states (`done`/`skipped`) and when there is
 * no live review — those have no in-flight phase to show.
 */
export type PrReviewPhaseKind =
  | 'slicing'
  | 'reviewing'
  | 'awaiting'
  | 'challenging'
  | 'fixing'
  | 'posting'

export interface PrReviewPhase {
  kind: PrReviewPhaseKind
  /** Slices whose review is finished (0 while slicing). */
  completed: number
  /** Total slices the reviewer grouped the diff into (0 while slicing). */
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
      // No todo list yet ⇒ still grouping the diff; otherwise working through the chunks.
      return isSlicingChunks(subtasks)
        ? { kind: 'slicing', completed: 0, total: 0 }
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
