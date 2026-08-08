import { pipelineMatchesPurpose, type PipelinePurpose } from '@cat-factory/contracts'
import type { Pipeline } from '~/types/domain'

/** What the pipeline builder's saved-pipeline library is being browsed at. */
export interface PipelineLibraryFilters {
  /** The draft's purpose. `null` = unclassified, which narrows nothing. */
  purpose?: PipelinePurpose | null
  /** The picked organizational label, or `null` for all of them. */
  label?: string | null
  /** Whether archived pipelines are included. */
  showArchived?: boolean
}

/**
 * The saved-pipeline library narrowed to what it lists, plus the count each dial is holding back.
 *
 * Only the purpose count is stated, because it is the only dial whose control does not already
 * show what it excluded: the label chips and the archive toggle name their own selection, while a
 * purpose lives one column away, above the agent palette. It is measured against what the OTHER
 * two already admit, the same promise `narrowAgentPalette` makes: relax THIS dial alone and you
 * get n more. Counting it over the whole library instead would name rows the label filter is
 * hiding either way, sending the reader to a control that cannot produce them.
 */
export interface NarrowedPipelineLibrary<T> {
  /** The pipelines every dial admits: what the library renders, in input order. */
  offered: T[]
  /** How many more the CURRENT label + archive selection would list at no purpose. */
  hiddenByPurpose: number
}

/**
 * Reduce `pipelines` to the rows the builder's library lists under `filters`.
 *
 * A pure reduction rather than three predicates inlined in the template for the reason
 * {@link import('./agentPalette').narrowAgentPalette} is one: it decides what is VISIBLE and it
 * owes an honest count, and a count re-derived at the call site as a subtraction measures the
 * wrong population. The purpose rule itself lives in `@cat-factory/contracts` beside the palette's
 * and the pickers', so the three cannot read a stored `purpose` in different directions.
 */
export function narrowPipelineLibrary<T extends Pick<Pipeline, 'purpose' | 'labels' | 'archived'>>(
  pipelines: readonly T[],
  filters: PipelineLibraryFilters,
): NarrowedPipelineLibrary<T> {
  const organized = (p: T) => {
    if (!filters.showArchived && p.archived) return false
    return !filters.label || (p.labels ?? []).includes(filters.label)
  }
  const suits = (p: T) => pipelineMatchesPurpose(p, filters.purpose)
  return {
    offered: pipelines.filter((p) => organized(p) && suits(p)),
    hiddenByPurpose: pipelines.filter((p) => organized(p) && !suits(p)).length,
  }
}
