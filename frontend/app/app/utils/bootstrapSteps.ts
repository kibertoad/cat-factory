import type { BootstrapStepState } from '@cat-factory/contracts'

// Display metadata for a bootstrap run's step states, the `catalog.ts` idea at the scale of one
// vocabulary: the icon and the two tones that render a state, in ONE record rather than three
// parallel ones keyed alike. Three had to be kept in step by hand, which is a silent way to give
// a newly added state (`stopped`, say) a red icon and calm text.
//
// Module scope rather than a component's `<script setup>`, where a top-level const is rebuilt for
// every instance: the step list renders on every in-progress, parked and failed bootstrap card on
// the board, plus the inspector and the failure card.

/** How one step state renders: its icon, the icon's tone, and the label's. */
export interface BootstrapStepStyle {
  icon: string
  iconClass: string
  labelClass: string
}

/**
 * The style per state. `stopped` is deliberately NOT the failure red: a run someone stopped is
 * stored as a failure without being one, and the step they stopped in is usually the review,
 * whose only actor is the reviewer themselves.
 */
export const BOOTSTRAP_STEP_STYLE: Record<BootstrapStepState, BootstrapStepStyle> = {
  pending: {
    icon: 'i-lucide-circle',
    iconClass: 'text-slate-500',
    labelClass: 'text-slate-500',
  },
  running: {
    icon: 'i-lucide-loader-circle',
    iconClass: 'animate-spin text-amber-400',
    labelClass: 'text-amber-100',
  },
  awaiting_review: {
    icon: 'i-lucide-user-check',
    iconClass: 'text-amber-400',
    labelClass: 'text-amber-100',
  },
  done: {
    icon: 'i-lucide-check-circle-2',
    iconClass: 'text-emerald-400',
    labelClass: 'text-slate-400',
  },
  failed: {
    icon: 'i-lucide-alert-triangle',
    iconClass: 'text-rose-400',
    labelClass: 'text-rose-200',
  },
  stopped: {
    icon: 'i-lucide-circle-stop',
    iconClass: 'text-slate-400',
    labelClass: 'text-slate-300',
  },
  unknown: {
    icon: 'i-lucide-help-circle',
    iconClass: 'text-slate-400',
    labelClass: 'text-slate-400',
  },
}
