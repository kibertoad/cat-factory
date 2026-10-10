import type { Server } from 'node:http'

// Why the e2e listeners hold idle keep-alive sockets far longer than a production one would.
//
// Node reaps an idle keep-alive socket after `keepAliveTimeout`, 5 SECONDS by default. Playwright's
// Node request context pools sockets per origin and reuses them across tests, and a spec routinely
// leaves one idle for longer than that while it drives the BROWSER. Dispatching the next request
// onto a socket the server is closing in that same window fails as `socket hang up`, and a
// non-idempotent POST is not auto-retried, so the spec dies on its first seeding call with an error
// that names nothing about what it was doing.
//
// That is the whole failure: `POST /workspaces` from the `seededBoard` fixture, before the spec
// under it had run a line. `testServer.ts`'s control channel already answers it by closing the
// connection after every response, but it fixed only its own listener, and the seeding calls that
// open EVERY spec go to the main backend.
//
// Closing connections is the wrong lever here: this listener also serves the SPA, whose live
// behaviour is what the specs assert on. Aligning the two ends is the fix instead. The reaper is
// the only party that closes a socket the client still believes in, so a `keepAliveTimeout` above
// any gap a run can produce (Playwright caps a test at 60s) means it never fires mid-run and the
// race has no window left. Holding idle sockets for the life of a test process costs nothing.

/** Comfortably above Playwright's 60s per-test timeout, so no in-run gap can reach the reaper. */
const E2E_KEEP_ALIVE_MS = 120_000

/**
 * Node requires `headersTimeout` to exceed `keepAliveTimeout`; raised in step rather than left at
 * its 60s default, which would otherwise sit BELOW the new keep-alive window.
 */
const E2E_HEADERS_TIMEOUT_MS = E2E_KEEP_ALIVE_MS + 5_000

/**
 * Stop `server` reaping the idle keep-alive sockets Playwright's request context pools.
 *
 * Apply to every listener a spec makes REST calls against. A listener the specs only reach through
 * the browser would not need it (Chromium retries an idempotent request on a reused-socket close),
 * but there is no listener here that is only ever reached that way, and applying it uniformly is
 * one fewer thing to be wrong about.
 */
export function holdKeepAliveSockets(server: unknown): void {
  const http = server as Partial<Server> | null
  if (!http || typeof http.keepAliveTimeout !== 'number') return
  http.keepAliveTimeout = E2E_KEEP_ALIVE_MS
  http.headersTimeout = E2E_HEADERS_TIMEOUT_MS
}
