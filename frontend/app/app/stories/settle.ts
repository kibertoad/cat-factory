// Waiting for a story's requests, so a play waits on the data it checks rather than on the clock.
//
// A `findBy*` query retries for one second, and a story's API request goes through msw's service
// worker, whose answer has no deadline. So the second of retries counts only time the page is
// idle: every `findBy*`, `waitFor` and user-event action waits until none of the story's API
// requests is in flight before it starts. A wait that runs out while a request it caused is still
// on its way (a debounced search sends it after the wait began) waits for that request and looks
// again, a few times at most. A query that fails on an idle page fails as before.
//
// The count is kept on the page, around `fetch`, not from msw's own events: msw hears of a request
// only after it has been through the service worker, so a request the component has just sent
// would not be counted yet when the play starts. The app sends every API request with `fetch`.
import { configure } from 'storybook/test'
import { nextTick } from 'vue'
import { isApiRequest, PENDING_HEADER } from './api'

/** How many times a wait that ran out looks again, when requests went out while it waited. */
const MAX_RETRIES = 3

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

/**
 * When a request counts as answered: once its whole body has arrived, so the app's own read of it
 * resolves in the same turn. A pending story's body never ends, so its request counts as answered
 * when its headers arrive, as it does for the component, which stays on its loading state.
 */
async function answered(response: Response): Promise<void> {
  if (response.headers.has(PENDING_HEADER)) return
  await response.clone().arrayBuffer()
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : input, window.location.href)
}

let tracking = false

/** Count the page's API requests from now on. */
function trackRequests(): void {
  if (tracking) return
  tracking = true
  const send = window.fetch.bind(window)
  window.fetch = (...args: Parameters<typeof fetch>) => {
    // Icons, fonts and Vite's own requests are not a story's data, and a slow CDN must not hold
    // up a play.
    if (!isApiRequest(requestUrl(args[0]))) return send(...args)
    inFlight++
    sent++
    const response = send(...args)
    response.then(answered).then(settled, settled)
    return response
  }
}

function noRequestInFlight(): Promise<void> {
  if (inFlight === 0) return Promise.resolve()
  return new Promise((resolve) => idle.push(resolve))
}

/**
 * Wait until the page has no API request in flight, and stays so across the render the last answer
 * caused and one turn of the event loop: an answer often starts the next request (a list, then its
 * details), and that one has to be waited for too.
 */
async function apiSettled(): Promise<void> {
  for (;;) {
    await noRequestInFlight()
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (inFlight === 0) return
  }
}

/**
 * Whether a failed attempt is a wait that ran out: a `findBy*` that found nothing, or a `waitFor`
 * whose check kept failing (a Testing Library error, a failed `expect` or jest-dom matcher, which
 * carry `actual` and `expected`, or the timeout itself). A user-event action that failed is not
 * one, and must not run twice.
 */
function isWaitThatRanOut(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.name === 'TestingLibraryElementError' ||
    error.name === 'AssertionError' ||
    ('actual' in error && 'expected' in error) ||
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
      for (let retry = 0; ; retry++) {
        await apiSettled()
        const before = sent
        try {
          return await run()
        } catch (error) {
          // A failed action, a wait that ran out on an idle page, or one that has looked again
          // enough times: that is the play's answer, with its own error.
          if (!isWaitThatRanOut(error) || sent === before || retry === MAX_RETRIES) throw error
        }
      }
    },
  })
}
