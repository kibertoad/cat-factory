import { useBreakpoints, breakpointsTailwind, useMediaQuery } from '@vueuse/core'

/**
 * Single source of truth for responsive / input-modality decisions across the SPA.
 *
 * `isCompact` is the app-wide "mobile/compact" flag: true below Tailwind's `lg`
 * (1024px), matching the breakpoint the already-responsive surfaces use
 * (`AgentStepDetail`, the review windows) so the whole shell stays consistent.
 *
 * `isTouch` reports that the *primary* pointer is coarse (phones/tablets) so a
 * component can enlarge hit targets without affecting precise-pointer (mouse)
 * desktops — orthogonal to width, since a small window on a desktop is compact but
 * not touch.
 *
 * `hasTouch` reports that *any* available pointer is coarse. It is the right check
 * for "can this surface be touched at all" — e.g. a touchscreen laptop or a
 * 2-in-1, whose *primary* pointer is the trackpad (`fine`, so `isTouch` is false)
 * but which can still be finger-panned. Use it for behaviour that must work the
 * moment a finger is on the glass (the board's one-finger pan); use `isTouch` for
 * the dominant-modality choices (hit-target sizing).
 */
export function useViewport() {
  const breakpoints = useBreakpoints(breakpointsTailwind)
  const isCompact = breakpoints.smaller('lg')
  const isTouch = useMediaQuery('(pointer: coarse)')
  const hasTouch = useMediaQuery('(any-pointer: coarse)')
  return { isCompact, isTouch, hasTouch }
}
