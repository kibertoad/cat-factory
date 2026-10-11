/**
 * Safe-area padding for the full-screen overlays, so a phone's notch, rounded corners and home
 * indicator never cover a header, a close button or an edge. The insets are physical, so the
 * sides are too. They resolve to 0 unless the viewport meta carries `viewport-fit=cover`
 * (`nuxt.config.ts`).
 *
 * Every class is spelled out literally: Tailwind generates only the class names it finds in the
 * source text, so a name assembled at runtime would compile to nothing.
 */

/**
 * A windowed overlay's gutter: 1rem, or the inset on that side when it is
 * larger, so the window always floats clear of the screen edge and of the notch.
 */
export const SAFE_AREA_GUTTER_CLASS = [
  'pt-[max(1rem,env(safe-area-inset-top))]',
  'pr-[max(1rem,env(safe-area-inset-right))]',
  'pb-[max(1rem,env(safe-area-inset-bottom))]',
  'pl-[max(1rem,env(safe-area-inset-left))]',
].join(' ')

/**
 * A full-bleed takeover's padding: only the inset, so on a screen without one the layout is
 * exactly the edge-to-edge one it was designed as. `safeArea.spec.ts` names every takeover that
 * must carry it.
 */
export const SAFE_AREA_INSET_CLASS = [
  'pt-[env(safe-area-inset-top)]',
  'pr-[env(safe-area-inset-right)]',
  'pb-[env(safe-area-inset-bottom)]',
  'pl-[env(safe-area-inset-left)]',
].join(' ')
