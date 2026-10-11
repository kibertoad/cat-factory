// ---------------------------------------------------------------------------
// The two views of a board (issue #2258): the QUEUE (every task across every service, in the
// column that says what it needs) and the BOARD (the canvas, where the work is planned).
//
// They are two views of one board, not two products: the queue reads the same lane verdict the
// canvas's swimlanes do. Which one a person opens on is THEIR choice, remembered as the view they
// used last, because the jobs differ: someone who reviews all day wants the list, someone who
// plans the next service wants the map.
// ---------------------------------------------------------------------------

export const WORK_VIEWS = ['queue', 'board'] as const
export type WorkView = (typeof WORK_VIEWS)[number]

/**
 * Where a person lands before they have chosen. The queue: it answers the first question a
 * person opens the app with ("what needs me?"), and the canvas is one click away.
 */
export const DEFAULT_WORK_VIEW: WorkView = 'queue'

export function isWorkView(value: unknown): value is WorkView {
  return typeof value === 'string' && (WORK_VIEWS as readonly string[]).includes(value)
}

/** The query parameter that opens a view, so a link can say "look at the queue". */
export const WORK_VIEW_PARAM = 'view'
