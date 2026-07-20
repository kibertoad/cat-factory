import type { StepSubtasks } from '~/types/execution'

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
