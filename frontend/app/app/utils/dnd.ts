/** Walk up from an event's target to find the block it landed on, if any. Works for any
 * DOM event (double-click, context menu, …): only `event.target` is read. */
export function blockIdFromEvent(event: Event): string | null {
  const el = (event.target as HTMLElement | null)?.closest('[data-block-id]')
  return el?.getAttribute('data-block-id') ?? null
}
