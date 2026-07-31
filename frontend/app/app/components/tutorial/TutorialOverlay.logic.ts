import { DEFAULT_TARGET_WAIT_MS } from '~/utils/tutorial'
import type { TutorialStep } from '~/utils/tutorial'

/**
 * The tour runtime's decision logic, extracted from `TutorialOverlay.vue` so it is
 * unit-testable (the vitest setup has no SFC transform — same split as
 * `AppOverlayHost.logic.ts`). The component keeps the DOM work (querying, measuring,
 * listeners); everything that DECIDES something lives here.
 */

/**
 * Which way the step cursor is travelling. It matters only for a step whose anchor
 * never appears: a skip must continue in the direction the user was already going,
 * or pressing Back onto a step whose control this deployment doesn't render would
 * bounce them straight forward again — an unusable Back button.
 */
export type TutorialDirection = 'forward' | 'back'

/** What the overlay does with a step whose anchor never appeared. */
export type SkipOutcome = { kind: 'move'; index: number } | { kind: 'complete' }

/**
 * What a `data-testid` may look like. Every one of the ~470 test ids in this layer is
 * lowercase kebab-case, and the e2e suite's convention keeps it that way, so this rejects
 * nothing real — which is what makes it usable as a GUARD rather than as escaping.
 *
 * A tour is DATA and a consumer deployment authors its own, so an id reaches
 * `querySelector` from outside this package. Escaping it is the obvious move and the wrong
 * one: `[data-testid="a\"b"]` is valid CSS that real selector engines disagree about (it
 * throws in happy-dom), so an id with a quote could still take down the tracking interval —
 * several times a second, for as long as the tour runs. Validating the shape instead means
 * no selector is ever built from a string that could break one, and an id that fails simply
 * finds no anchor, which the runtime already handles as a skipped step.
 */
export const TARGET_ID_PATTERN = /^[a-z0-9-]+$/

/** Is this a well-formed anchor id, i.e. safe to put in a selector? */
export function isSafeTargetId(id: string): boolean {
  return TARGET_ID_PATTERN.test(id)
}

/** The `data-testid`s a step declares, in priority order (target first, then fallbacks). */
export function stepTargetIds(step: TutorialStep): string[] {
  return [step.target, ...(step.altTargets ?? [])].filter((id): id is string => id !== undefined)
}

/** The selectors to try for a step: its declared ids, minus any that are malformed. */
export function stepTargetSelectors(step: TutorialStep): string[] {
  return stepTargetIds(step)
    .filter(isSafeTargetId)
    .map((id) => `[data-testid="${id}"]`)
}

/** How long this step may spend looking for its anchor before it is skipped. */
export function waitBudgetMs(step: TutorialStep): number {
  return step.waitForTargetMs ?? DEFAULT_TARGET_WAIT_MS
}

/**
 * Where the cursor goes when the current step's anchor never appeared.
 *
 * Travelling BACK off the first step has nowhere further back to go, so it reverses to
 * forward rather than pinning the tour on an anchor that is never coming.
 */
export function resolveSkip(
  index: number,
  direction: TutorialDirection,
  total: number,
): SkipOutcome {
  if (direction === 'back' && index > 0) return { kind: 'move', index: index - 1 }
  return index + 1 < total ? { kind: 'move', index: index + 1 } : { kind: 'complete' }
}

/** Does this real click count as the "now click this" step's advance? */
export function isTargetClickAdvance(
  step: TutorialStep | null,
  targetEl: { contains: (node: Node) => boolean } | null,
  eventTarget: EventTarget | null,
): boolean {
  if (!step || step.advanceOn !== 'target-click' || !targetEl) return false
  return eventTarget instanceof Node && targetEl.contains(eventTarget)
}

/**
 * A tour is ABRIDGED when it reached its end having skipped steps: the controls those
 * steps point at aren't part of this board/role/deployment. The final card says so
 * instead of congratulating the user on a walkthrough they never saw — absent and
 * complete must not render the same.
 */
export function tourWasAbridged(skippedStepIds: ReadonlySet<string>): boolean {
  return skippedStepIds.size > 0
}
