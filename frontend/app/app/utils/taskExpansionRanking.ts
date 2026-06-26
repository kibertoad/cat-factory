/**
 * Pure ranking for the task-expansion gate (see `composables/useTaskExpansion.ts`).
 *
 * A task card grows DOWNWARD when it expands its pipeline, so its `top`/`left`/`right`
 * never move — only its height does. We rank candidates by the screen centre's distance
 * to each card's stable HEADER anchor (the top edge), which is what the user reads as
 * "the card I'm looking at". Ranking on the header (not the expanded footprint) is what
 * stops a tall card from winning just because its expanded body happens to cover the
 * centre: a compact card whose header sits right at the centre beats a neighbour whose
 * header is parked at the top of the screen, even when both bodies overlap the centre.
 *
 * Because the anchor uses only top/left/right (all stable as the card expands and
 * collapses), the ordering can't oscillate. A tall card you've scrolled past the top of
 * is no longer kept expanded by the ranking itself — the hover "pin" in the driver keeps
 * the pipeline you're pointing at from collapsing while you scroll.
 */
export type Rect = { left: number; right: number; top: number; bottom: number }

/**
 * Squared distance from the screen centre `(cx, cy)` to a card's stable header anchor
 * (the centre of its top edge). Smaller = nearer the centre = ranks first.
 */
export function headerDistanceSq(card: Rect, cx: number, cy: number): number {
  const ax = (card.left + card.right) / 2
  const dx = ax - cx
  const dy = card.top - cy
  return dx * dx + dy * dy
}
