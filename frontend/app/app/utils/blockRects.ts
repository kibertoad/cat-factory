/**
 * One measurement pass's view of the board's rendered block cards.
 *
 * The two DOM-measuring drivers on the canvas (dependency edges, task expansion) resolve cards
 * by `[data-block-id]`, which is what lets an arrow follow pan / zoom / drag for free. Done a
 * card at a time it is also the drivers' whole cost: the edge overlay ran two
 * `document.querySelector` scans plus two `getBoundingClientRect` reads PER LINK, so a task with
 * five dependencies was found and measured five times in the same frame, and the expansion sweep
 * ran one scan per candidate task.
 *
 * A pass builds this once instead: one `querySelectorAll` over the board, then map lookups, with
 * each element measured at most once. First-in-document-order wins per id, matching what
 * `document.querySelector` returned before, so a card also rendered outside the canvas (the focus
 * view, the inspector) resolves to the same element it always did.
 *
 * It is deliberately a SNAPSHOT: geometry read inside one frame must not change halfway through
 * a pass, and the next pass builds a fresh one.
 */
export type BlockMeasurements = {
  /** The rendered card for a block id, or null when nothing on the page renders it. */
  elementFor: (id: string) => HTMLElement | null
  /** The element's viewport rect, measured once per pass. */
  rectFor: (el: Element) => DOMRect
}

export const BLOCK_ID_ATTRIBUTE = 'data-block-id'

export function measureBlocks(root: ParentNode = document): BlockMeasurements {
  const elements = new Map<string, HTMLElement>()
  for (const el of root.querySelectorAll<HTMLElement>(`[${BLOCK_ID_ATTRIBUTE}]`)) {
    const id = el.getAttribute(BLOCK_ID_ATTRIBUTE)
    if (id && !elements.has(id)) elements.set(id, el)
  }

  const rects = new WeakMap<Element, DOMRect>()

  return {
    elementFor: (id) => elements.get(id) ?? null,
    rectFor(el) {
      const cached = rects.get(el)
      if (cached) return cached
      const rect = el.getBoundingClientRect()
      rects.set(el, rect)
      return rect
    },
  }
}
