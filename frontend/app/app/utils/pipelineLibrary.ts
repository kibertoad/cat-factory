import { pipelineMatchesPurpose, type PipelinePurpose } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'

/** What the pipeline builder's saved-pipeline library is being browsed at. */
export interface PipelineLibraryFilters {
  /**
   * The purpose to list, or `null` for "every purpose" — the library's own relaxation, NOT an
   * unclassified draft. `Pipeline.purpose` is mandatory, so the draft always has one; `null` is
   * the reader saying they want to browse past it.
   */
  purpose?: PipelinePurpose | null
  /** The picked organizational label, or `null` for all of them. */
  label?: string | null
  /** Whether archived pipelines are included. */
  showArchived?: boolean
}

/**
 * The saved-pipeline library narrowed to what it lists, plus what each hidden-by-default dial is
 * holding back.
 *
 * Both counts are measured against what the OTHER dials already admit, which is the promise
 * `narrowAgentPalette` established: relax THIS dial alone and you get n more. Counting either over
 * the whole catalog would name rows another filter is hiding either way, sending the reader to a
 * control that cannot produce them.
 *
 * The label chips are the one dial with no count, because they are the one dial that already shows
 * its own selection and its own alternatives.
 */
export interface NarrowedPipelineLibrary<T> {
  /** The pipelines every dial admits: what the library renders, in input order. */
  offered: T[]
  /** How many more the CURRENT label + archive selection would list at every purpose. */
  hiddenByPurpose: number
  /**
   * How many ARCHIVED pipelines the current purpose + label selection covers.
   *
   * Deliberately independent of `showArchived`, unlike {@link hiddenByPurpose}: this is what the
   * archive toggle governs, and it has to be the same number in both of the toggle's positions or
   * the control that turned archived rows ON would vanish the moment it worked, stranding them
   * visible with no way back. While they are hidden it is also exactly what relaxing that dial
   * alone would add.
   */
  archivedInScope: number
}

/**
 * Reduce `pipelines` to the rows the builder's library lists under `filters`.
 *
 * A pure reduction rather than three predicates inlined in the template for the reason
 * {@link import('./agentPalette').narrowAgentPalette} is one: it decides what is VISIBLE and it
 * owes an honest count of what it hid, and a count re-derived at the call site as a subtraction
 * measures the wrong population. The purpose rule itself lives in `@cat-factory/contracts` beside
 * the palette's and the pickers', so the three cannot read a stored `purpose` in different
 * directions.
 */
export function narrowPipelineLibrary<T extends Pick<Pipeline, 'purpose' | 'labels' | 'archived'>>(
  pipelines: readonly T[],
  filters: PipelineLibraryFilters,
): NarrowedPipelineLibrary<T> {
  const labelled = (p: T) => !filters.label || (p.labels ?? []).includes(filters.label)
  const listed = (p: T) => Boolean(filters.showArchived) || !p.archived
  const suits = (p: T) => pipelineMatchesPurpose(p, filters.purpose)
  return {
    offered: pipelines.filter((p) => labelled(p) && listed(p) && suits(p)),
    hiddenByPurpose: pipelines.filter((p) => labelled(p) && listed(p) && !suits(p)).length,
    archivedInScope: pipelines.filter((p) => labelled(p) && suits(p) && p.archived).length,
  }
}
