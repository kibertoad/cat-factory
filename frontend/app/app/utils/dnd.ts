import type { BlockType } from '~/types/domain'

/** MIME-ish key used to carry palette payloads across the HTML5 DnD boundary. */
export const DND_MIME = 'application/agent-board'

export type DndPayload =
  | { kind: 'block'; blockType: BlockType }
  | { kind: 'pipeline'; pipelineId: string }

export function setDndPayload(event: DragEvent, payload: DndPayload) {
  event.dataTransfer?.setData(DND_MIME, JSON.stringify(payload))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy'
}

export function readDndPayload(event: DragEvent): DndPayload | null {
  const raw = event.dataTransfer?.getData(DND_MIME)
  if (!raw) return null
  try {
    return JSON.parse(raw) as DndPayload
  } catch {
    return null
  }
}

/** Walk up from an event's target to find the block it landed on, if any. Works for any
 * DOM event (drop, double-click, …) — only `event.target` is read. */
export function blockIdFromEvent(event: Event): string | null {
  const el = (event.target as HTMLElement | null)?.closest('[data-block-id]')
  return el?.getAttribute('data-block-id') ?? null
}
