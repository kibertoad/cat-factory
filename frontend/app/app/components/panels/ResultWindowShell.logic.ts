// The result-window width vocabulary, extracted from `ResultWindowShell.vue` so it can be
// asserted (see `ResultWindowShell.logic.spec.ts`, which pins every window's bucket against a
// table naming its reason — the shape `nav-contributions.spec.ts` uses for the advanced-nav set).
//
// WHICH bucket a window takes, and the reading-measure obligation `full` carries, are documented
// on the shell's `width` prop — that is what a window author reads. This module owns only the
// vocabulary and its class mapping.

/** Card width buckets — see `ResultWindowShell.vue`'s `width` prop for what picks `full`. */
export type ResultWindowWidth = '3xl' | '4xl' | '5xl' | 'full'

/**
 * The bucket → cap mapping. `full` is deliberately `max-w-none` rather than a bigger number:
 * the panel's `w-full` then spans the backdrop, which the variant insets by one gutter (`m-4`
 * stretched, `p-4` centered), so the window fills the screen and still reads as a window rather
 * than a repaint of the app. A `Record` over the union, so a new bucket fails to compile until
 * it is mapped.
 */
export const RESULT_WINDOW_WIDTH_CLASS: Record<ResultWindowWidth, string> = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  full: 'max-w-none',
}

/**
 * The reading measure a `full` window puts on a run of continuous prose — the step reader's own
 * (`AgentStepDetail`, `mx-auto max-w-3xl` over the same 13px `.reader-prose`), so the surfaces
 * cannot drift into two opinions about how wide prose should be.
 */
export const PROSE_MEASURE_CLASS = 'max-w-3xl'
