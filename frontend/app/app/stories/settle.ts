// Waiting for a story's requests, so a play waits on the data it checks rather than on the clock.
//
// A `findBy*` query retries for one second. In CI a story's request goes through msw's service
// worker on a loaded machine, and its answer can take longer than that, so a play that went
// straight to `findBy*` failed now and then on a state its story does render. So the second of
// retries counts only time the page is idle: every `findBy*`, `waitFor` and user-event action waits
// until the page has no request in flight before it starts, and one that runs out while a request
// it caused is still on its way (a debounced search sends it after the wait began) waits for that
// request and looks again. A query that fails on an idle page fails as before.
//
// The count is kept on the page, around `fetch`, not from msw's own events: msw hears of a request
// only after it has been through the service worker, so a request the component has just sent
// would not be counted yet when the play starts. The app sends every API request with `fetch`.
import { configure } from 'storybook/test'
import { nextTick } from 'vue'

let inFlight = 0
/** How many requests have been sent, to tell whether one went out during a query's second. */
let sent = 0
let idle: Array<() => void> = []

function settled(): void {
  inFlight--
  if (inFlight > 0) return
  const waiting = idle
  idle = []
  for (const resolve of waiting) resolve()
}

let tracking = false

/** Count the page's `fetch` calls from now on. */
function trackRequests(): void {
  if (tracking) return
  tracking = true
  const send = window.fetch.bind(window)
  window.fetch = (...args: Parameters<typeof fetch>) => {
    inFlight++
    sent++
    const response = send(...args)
    // A response counts once its headers arrive, as the app's own `await fetch()` does. A pending
    // story's body never ends, and must not keep the page busy for ever.
    response.then(settled, settled)
    return response
  }
}

function noRequestInFlight(): Promise<void> {
  if (inFlight === 0) return Promise.resolve()
  return new Promise((resolve) => idle.push(resolve))
}

/**
 * Wait until the page has no request in flight, and stays so across the render the last answer
 * caused and one turn of the event loop: an answer often starts the next request (a list, then its
 * details), and that one has to be waited for too.
 */
export async function apiSettled(): Promise<void> {
  for (;;) {
    await noRequestInFlight()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (inFlight === 0) return
  }
}

/**
 * Whether a failed attempt is a wait that ran out (a `findBy*` that found nothing, a `waitFor`
 * whose check kept failing), as opposed to a user-event action that failed, which must not run
 * twice.
 */
function isWaitThatRanOut(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === 'TestingLibraryElementError' ||
    error.name === 'AssertionError' ||
    error.message.startsWith('Timed out in waitFor')
  )
}

/**
 * Make every `findBy*` and `waitFor` in a play, and every user-event action, count only the time the
 * page is idle against its one second of retries. Called once per preview, before any story renders.
 *
 * It is configured HERE, in a module the stories share, not in `preview.ts`: the browser bundles
 * Testing Library twice, once in `storybook/test` as a story imports it and once in Storybook's
 * preview runtime, and only the first is the one a play's `screen` uses.
 */
export function waitOnRequests(): void {
  trackRequests()
  configure({
    asyncWrapper: async (run) => {
      for (;;) {
        await apiSettled()
        const before = sent
        try {
          return await run()
        } catch (error) {
          // A failed action, or a wait that ran out on an idle page: that is the play's answer.
          if (!isWaitThatRanOut(error) || (sent === before && inFlight === 0)) throw error
        }
      }
    },
  })
}
