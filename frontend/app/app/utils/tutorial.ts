import type { NavGates } from '~/modular/nav-contributions'

/**
 * In-app tutorial tours: the pure data model + geometry, shared by the tour catalog
 * (`modular/tutorial-tours.ts`), the tutorial store, and the coach-mark overlay
 * (`components/tutorial/TutorialOverlay.vue`).
 *
 * A tour is DATA, not components: an ordered list of steps, each pointing at an existing
 * on-screen control by its `data-testid` and carrying i18n keys for what to tell the user.
 * That keeps tours declarative (a consumer deployment contributes its own through the
 * `tutorialTours` slot via `registerAppModule`, exactly like nav items) and keeps the whole
 * runtime — anchor tracking, tooltip placement, advance handling — in ONE overlay component
 * that every tour shares.
 */

/** How a step advances to the next one. */
export type TutorialAdvance =
  /** The user reads and presses the tooltip's Next button (the default). */
  | 'next'
  /**
   * The user clicks the highlighted control itself — the "now click this" steps. The
   * tooltip shows a click hint instead of a Next button, so the app reacts to the real
   * click (opening the real modal, creating the real task) and the tour follows along.
   */
  | 'target-click'

/** Preferred tooltip side relative to the anchor; the overlay falls back when it can't fit. */
export type TutorialPlacement = 'top' | 'bottom' | 'left' | 'right'

export interface TutorialStep {
  /** Stable id, unique within the tour (progress display + specs key off it). */
  id: string
  /**
   * `data-testid` of the control this step points at. Absent = a centered card (intro /
   * wrap-up steps). Reusing the e2e anchor vocabulary is deliberate: those ids are already
   * the stable, behaviour-neutral way to name a control, and a tour stop is the same kind
   * of consumer as a spec.
   */
  target?: string
  /**
   * Fallback `data-testid`s tried in order when {@link target} is absent from the DOM —
   * for controls that render under a different id in some states (e.g. a frame's add-task
   * button on an empty frame).
   */
  altTargets?: readonly string[]
  titleKey: string
  bodyKey: string
  placement?: TutorialPlacement
  /** Defaults to `'next'`. */
  advanceOn?: TutorialAdvance
  /**
   * How long the overlay waits for the target to appear before SKIPPING the step
   * (ms, default {@link DEFAULT_TARGET_WAIT_MS}). A missing anchor is expected, not an
   * error: the control may be RBAC-hidden, tier-hidden, or simply not part of this
   * deployment, and a tour must degrade to the steps that do apply. Steps whose target
   * only appears after the previous step's click (inside a just-opened modal) may need a
   * longer wait.
   */
  waitForTargetMs?: number
}

export interface TutorialTour {
  /** Stable id; completion is persisted against it, so renaming one resets its state. */
  id: string
  titleKey: string
  descriptionKey: string
  icon?: string
  /** Sort key in the tour list; ties break on `id` so the order is deterministic. */
  order: number
  /**
   * Availability gate over the same reactive {@link NavGates} the nav catalog uses, so a
   * tour about a surface the caller can't reach (no board write, no GitHub) never shows.
   * Absent = always offered.
   */
  when?: (gates: NavGates) => boolean
  steps: readonly TutorialStep[]
}

/** How long the overlay polls for a step's anchor before auto-skipping the step. */
export const DEFAULT_TARGET_WAIT_MS = 4000

/** How often the overlay re-queries / re-measures its anchor (canvas pans, panels open). */
export const TARGET_TRACK_INTERVAL_MS = 150

/** Deterministic tour-list order: `order`, then `id`. */
export function sortTours(tours: readonly TutorialTour[]): TutorialTour[] {
  return [...tours].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** A DOMRect-shaped box, structurally typed so the geometry below is unit-testable. */
export interface TutorialRect {
  top: number
  left: number
  width: number
  height: number
}

export interface CoachMarkLayout {
  top: number
  left: number
  /** The side actually used (a preferred side that doesn't fit falls back), or centered. */
  placement: TutorialPlacement | 'center'
}

/** Gap between the anchor's highlight ring and the tooltip card. */
const TOOLTIP_GAP = 12
/** Minimum distance the tooltip keeps from the viewport edges. */
const VIEWPORT_MARGIN = 8

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), Math.max(min, max))

/**
 * Where the tooltip card goes for a given anchor. Pure geometry so the fallback rules are
 * pinned by unit tests rather than eyeballed:
 *
 *  - no anchor ⇒ centered (intro / wrap-up steps);
 *  - the preferred side is used when the card fits between anchor and viewport edge,
 *    otherwise sides are tried `bottom → top → right → left`;
 *  - nothing fits (tiny viewport) ⇒ the bottom position, clamped — partially covering the
 *    anchor beats disappearing off-screen;
 *  - the cross-axis is centered on the anchor and clamped to the viewport margin.
 */
export function computeCoachMarkLayout(
  target: TutorialRect | null,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred?: TutorialPlacement,
): CoachMarkLayout {
  if (!target) {
    return {
      top: Math.max(VIEWPORT_MARGIN, (viewport.height - tooltip.height) / 2),
      left: Math.max(VIEWPORT_MARGIN, (viewport.width - tooltip.width) / 2),
      placement: 'center',
    }
  }

  const fits: Record<TutorialPlacement, boolean> = {
    top: target.top - TOOLTIP_GAP - tooltip.height >= VIEWPORT_MARGIN,
    bottom:
      target.top + target.height + TOOLTIP_GAP + tooltip.height <=
      viewport.height - VIEWPORT_MARGIN,
    left: target.left - TOOLTIP_GAP - tooltip.width >= VIEWPORT_MARGIN,
    right:
      target.left + target.width + TOOLTIP_GAP + tooltip.width <= viewport.width - VIEWPORT_MARGIN,
  }
  const fallbackOrder: TutorialPlacement[] = ['bottom', 'top', 'right', 'left']
  const placement =
    preferred && fits[preferred]
      ? preferred
      : (fallbackOrder.find((side) => fits[side]) ?? 'bottom')

  const centeredLeft = target.left + target.width / 2 - tooltip.width / 2
  const centeredTop = target.top + target.height / 2 - tooltip.height / 2
  const maxLeft = viewport.width - tooltip.width - VIEWPORT_MARGIN
  const maxTop = viewport.height - tooltip.height - VIEWPORT_MARGIN

  switch (placement) {
    case 'top':
      return {
        top: target.top - TOOLTIP_GAP - tooltip.height,
        left: clamp(centeredLeft, VIEWPORT_MARGIN, maxLeft),
        placement,
      }
    case 'bottom':
      return {
        // Clamped: this is also the "nothing fits" fallback, where overlap is accepted.
        top: clamp(target.top + target.height + TOOLTIP_GAP, VIEWPORT_MARGIN, maxTop),
        left: clamp(centeredLeft, VIEWPORT_MARGIN, maxLeft),
        placement,
      }
    case 'left':
      return {
        top: clamp(centeredTop, VIEWPORT_MARGIN, maxTop),
        left: target.left - TOOLTIP_GAP - tooltip.width,
        placement,
      }
    case 'right':
      return {
        top: clamp(centeredTop, VIEWPORT_MARGIN, maxTop),
        left: target.left + target.width + TOOLTIP_GAP,
        placement,
      }
  }
}
