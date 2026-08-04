import type { ReproductionStatus } from '~/types/reproduction'

// Presentation for the BUGFIX REPRODUCTION PROOF verdict.
//
// The lookup is by a wire value, so it lives here as an EXHAUSTIVE `Record` keyed off the
// contracts union rather than as a t() call over a key assembled at the call site. The typed-key
// check cannot see a runtime-assembled key, so a fourth verdict added to the union would ship as a
// blank chip on exactly the surface whose job is to say what was and was not proven; keyed this
// way it fails to compile until the copy exists.

export interface ReproductionStatusPresentation {
  /** Short chip copy: the verdict as one or two words. */
  chip: string
  /** One sentence a reviewer decides on. */
  verdict: string
  icon: string
  /** Whether this verdict IS proof — the only one a collapsed row states completely. */
  proven: boolean
}

export const REPRODUCTION_STATUS_KEYS: Record<ReproductionStatus, ReproductionStatusPresentation> =
  {
    reproduced: {
      chip: 'panels.stepDetail.reproduction.status.reproduced',
      verdict: 'panels.stepDetail.reproduction.verdict.reproduced',
      icon: 'i-lucide-bug-off',
      proven: true,
    },
    inconclusive: {
      chip: 'panels.stepDetail.reproduction.status.inconclusive',
      verdict: 'panels.stepDetail.reproduction.verdict.inconclusive',
      icon: 'i-lucide-bug',
      proven: false,
    },
    declared_infeasible: {
      chip: 'panels.stepDetail.reproduction.status.declared_infeasible',
      verdict: 'panels.stepDetail.reproduction.verdict.declared_infeasible',
      icon: 'i-lucide-clipboard-list',
      proven: false,
    },
  }

/**
 * The two checkouts the same command was run against. A literal pair rather than a lookup: it is
 * the feature's own vocabulary (the tree BEFORE the change and the tree after it), not a wire
 * union that can grow.
 */
export const REPRODUCTION_TREE_KEYS = {
  base: 'panels.stepDetail.reproduction.tree.base',
  final: 'panels.stepDetail.reproduction.tree.final',
} as const
