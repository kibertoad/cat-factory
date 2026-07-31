/**
 * The decisions the `NavGates` service makes that are worth testing without a Pinia runtime.
 * `nav-gates.ts` itself is pure store wiring (getters over computeds); everything that
 * DECIDES something lives here, the same split as `TutorialOverlay.logic.ts`.
 */

/** One park (an open decision or a pending approval gate) as the execution store projects it. */
export interface ParkedGateRef {
  blockId: string
  agentKind?: string
}

/**
 * Is some park actually SHOWING a human an action to take?
 *
 * The gates this answers (`boardHasOpenDecision` / `boardHasPendingApproval`) exist to offer
 * a tour that anchors on a task card's attention affordance (`task-resolve`), so they have to
 * mean what makes that affordance RENDER — not merely "a park exists somewhere in the cached
 * runs". Two facts the raw store counts miss, both of which would offer the tour onto a board
 * with no control to point at (the tour then anchor-skips and reports itself abridged, which
 * is exactly the noise per-step `when` gating exists to avoid):
 *
 *  - a park on a frame or module block has no task card, so nothing renders the action;
 *  - a reviewer gate mid-cycle is deliberately SUPPRESSED by the card (`TaskCard.pendingApproval`
 *    → `useReviewStage().isBackground`): while the driver is folding answers or re-reviewing,
 *    the gate needs no human and the card shows a working indicator instead.
 *
 * Both predicates are injected rather than reached for, so the rule is checkable on plain data.
 */
export function hasActionablePark(
  parks: readonly ParkedGateRef[],
  isTaskBlock: (blockId: string) => boolean,
  isBackground: (agentKind: string | undefined, blockId: string) => boolean,
): boolean {
  return parks.some((p) => isTaskBlock(p.blockId) && !isBackground(p.agentKind, p.blockId))
}
