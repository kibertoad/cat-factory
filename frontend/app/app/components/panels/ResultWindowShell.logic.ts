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
 * the panel's `w-full` then spans the backdrop, which insets it by one gutter
 * (`RESULT_WINDOW_GUTTER_CLASS`), so the window fills the screen and still reads as a window
 * rather than a repaint of the app. A `Record` over the union, so a new bucket fails to compile until
 * it is mapped.
 */
export const RESULT_WINDOW_WIDTH_CLASS: Record<ResultWindowWidth, string> = {
  '3xl': 'max-w-3xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
  full: 'max-w-none',
}

/**
 * The backdrop's gutter around the panel, in both variants: 1rem, or the device's safe-area inset
 * on that side when it is larger (a notch, rounded corners, the home indicator). The insets are
 * physical, so the sides are too. They resolve to 0 unless the viewport meta carries
 * `viewport-fit=cover` (`nuxt.config.ts`), which leaves the plain 1rem.
 */
export const RESULT_WINDOW_GUTTER_CLASS = [
  'pt-[max(1rem,env(safe-area-inset-top))]',
  'pr-[max(1rem,env(safe-area-inset-right))]',
  'pb-[max(1rem,env(safe-area-inset-bottom))]',
  'pl-[max(1rem,env(safe-area-inset-left))]',
].join(' ')

/**
 * Stops scroll chaining out of every scroll container inside a window, the shell's and the
 * window body's alike: scrolling past the end of a list no longer scrolls what is behind it,
 * and on a phone it no longer triggers pull-to-refresh, which reloads the app and drops the
 * window. A window's body is its own markup, so the shell reaches it by the overflow utilities
 * the windows use (and by tag for a text area) rather than each window repeating `overscroll-contain`.
 */
export const RESULT_WINDOW_SCROLL_CONTAIN_CLASS = [
  '[&_.overflow-auto]:overscroll-contain',
  '[&_.overflow-y-auto]:overscroll-contain',
  '[&_.overflow-x-auto]:overscroll-contain',
  '[&_textarea]:overscroll-contain',
].join(' ')

/**
 * The reading measure a `full` window puts on a run of continuous prose — the step reader's own
 * (`AgentStepDetail`, `mx-auto max-w-3xl` over the same 13px `.reader-prose`), so the surfaces
 * cannot drift into two opinions about how wide prose should be.
 */
export const PROSE_MEASURE_CLASS = 'max-w-3xl'
