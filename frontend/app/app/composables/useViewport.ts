import { useBreakpoints, breakpointsTailwind, useMediaQuery } from '@vueuse/core'

/**
 * Single source of truth for responsive / input-modality decisions across the SPA.
 *
 * `isCompact` is the app-wide "mobile/compact" flag: true below Tailwind's `lg`
 * (1024px), matching the breakpoint the already-responsive surfaces use
 * (`AgentStepDetail`, the review windows) so the whole shell stays consistent.
 *
 * `isTouch` reports a coarse pointer (phones/tablets) so a component can enlarge
 * hit targets without affecting precise-pointer (mouse) desktops — orthogonal to
 * width, since a small window on a desktop is compact but not touch.
 */
export function useViewport() {
  const breakpoints = useBreakpoints(breakpointsTailwind)
  const isCompact = breakpoints.smaller('lg')
  const isTouch = useMediaQuery('(pointer: coarse)')
  return { isCompact, isTouch }
}
