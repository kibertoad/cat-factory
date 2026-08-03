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

/**
 * Vue Flow's per-node wrapper, which carries the node id in `data-id`. The board is a
 * TRANSFORM-panned canvas rather than a scroll container, so an anchor inside one of these is
 * revealed by moving the camera (`fitView({ nodes })`), where every other anchor is revealed
 * by `scrollIntoView`. Asking the DOM which of the two an element is beats keying off the
 * step's target id, since the same id (`task-card`) is a canvas node on the board and a plain
 * list row in a panel.
 */
export const BOARD_NODE_SELECTOR = '.vue-flow__node'

/** The part of an element the reveal path needs: ancestry, and that ancestor's node id. */
interface RevealNode {
  closest(selector: string): { getAttribute(name: string): string | null } | null
}

/**
 * The board-canvas node id owning this element, or null when the element is not on the canvas
 * (so the caller scrolls it into view instead). An empty `data-id` counts as absent: Vue Flow
 * would match nothing, and a `fitView` over an unknown id silently does nothing at all — which
 * would look exactly like a reveal that ran.
 */
export function boardNodeIdFor(el: RevealNode | null): string | null {
  const id = el?.closest(BOARD_NODE_SELECTOR)?.getAttribute('data-id') ?? null
  return id !== null && id.length > 0 ? id : null
}

/** The part of a clicked node this check needs: CSS-selector ancestry. */
interface ClickedNode {
  closest(selector: string): unknown
}

/** The clicked node as something we can ask about ancestry, or null (a text node, `document`). */
function asClickedNode(eventTarget: EventTarget | null): ClickedNode | null {
  const node = eventTarget as ClickedNode | null
  return node && typeof node.closest === 'function' ? node : null
}

/**
 * Does this real click count as the "now click this" step's advance?
 *
 * Matched against the step's SELECTORS rather than against the one element the tracker
 * happened to highlight, because several of the controls a tour points at are rendered once
 * PER BOARD ITEM: `task-card`, `task-resolve`, `run-step`. The tracker anchors its ring to
 * the first match in the DOM, which is not necessarily the card the step's own copy is
 * asking for ("open a task whose run has finished"). Requiring the click to land inside THAT
 * element meant a user who clicked the right card got no advance at all — and a
 * click-to-advance step renders no Next button, so the tour had no way forward but Skip.
 * Any instance of the control the step names is the action the step asked for.
 */
export function isTargetClickAdvance(
  step: TutorialStep | null,
  eventTarget: EventTarget | null,
): boolean {
  if (!step || step.advanceOn !== 'target-click') return false
  const node = asClickedNode(eventTarget)
  if (!node) return false
  return stepTargetSelectors(step).some((selector) => node.closest(selector) != null)
}

/**
 * The skipped steps whose absence is a DEFECT — which is what the final card's "abridged"
 * notice is about: the controls those steps point at aren't part of this board/role/
 * deployment, so saying nothing would congratulate the user on a walkthrough they never saw.
 *
 * A step carrying a `when` is excluded, because it has already declared that not applying is
 * a legitimate state rather than a missing control. Normally such a step is DROPPED before
 * the tour runs (see `resolveTours`), so it never reaches the skip path at all — but with no
 * gates service wired (a bare install, where nothing is withheld) every branch of a tour is
 * kept, and exactly one of them can ever anchor. Counting the other as abridged would put a
 * permanent "you missed some of this" on a tour that showed the user precisely the branch
 * their board is on.
 */
export function unexpectedlySkippedSteps(
  skippedStepIds: ReadonlySet<string>,
  steps: readonly TutorialStep[],
): TutorialStep[] {
  return steps.filter((s) => skippedStepIds.has(s.id) && s.when === undefined)
}
