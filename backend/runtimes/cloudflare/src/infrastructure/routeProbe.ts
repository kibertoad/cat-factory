import { connect } from 'cloudflare:sockets'
import type { RouteProbe, RouteProbeOutcome, RouteProbeRequest } from '@cat-factory/kernel'
import { getErrorMessage } from '@cat-factory/kernel'

// The Worker facade's `RouteProbe`: one bounded TCP connect through `cloudflare:sockets`, the
// symmetric twin of the Node facade's `net` probe. See `kernel/src/ports/route-probe.ts` for why
// the platform proves a route with a socket rather than a request.
//
// The classification is coarser here than on Node, and that is a runtime fact rather than a
// choice: workerd surfaces a connect failure as an `Error` with a message, not an `errno`, so the
// three causes Node tells apart (`ENOTFOUND`, `ETIMEDOUT`, `ECONNREFUSED`) arrive as prose. The
// two answers that MATTER are still exact, because they are the ones a decision hangs on: the
// connection either opened or it did not. What degrades is only which layer gets named, and it
// degrades to `probe_failed`, which says "we could not tell" rather than guessing a layer.

/** Substrings workerd uses for a name that resolved nowhere. Matched case-insensitively. */
const UNRESOLVED_MARKERS = ['could not be resolved', 'name resolution', 'enotfound', 'dns']
/** Substrings workerd uses for a route that reached something that said no. */
const REFUSED_MARKERS = ['connection refused', 'econnrefused']

/**
 * Read what a workerd connect failure was, falling back to `probe_failed`.
 *
 * A prose match, which is exactly as unreliable as it sounds, so it is confined to the ENRICHMENT
 * and never to the verdict: an unmatched message is `probe_failed`, which the deployer treats as
 * "could not tell" and never as evidence the environment is dead. A future workerd wording change
 * therefore loses a layer name, not a run.
 */
function classify(error: unknown, timedOut: boolean): RouteProbeOutcome {
  if (timedOut) return { state: 'no_route' }
  const message = getErrorMessage(error).toLowerCase()
  if (UNRESOLVED_MARKERS.some((marker) => message.includes(marker))) return { state: 'unresolved' }
  if (REFUSED_MARKERS.some((marker) => message.includes(marker))) return { state: 'refused' }
  return { state: 'failed', detail: getErrorMessage(error) }
}

/**
 * Open a socket to the request's target and resolve with what happened, never rejecting.
 *
 * `connect()` returns before the connection is established, so the handshake is awaited through
 * `socket.opened`; the timeout races that promise rather than wrapping the whole call. The socket
 * is closed on every exit path including the success one: the probe wants the handshake and
 * nothing after it.
 */
export const workerRouteProbe: RouteProbe = async (
  req: RouteProbeRequest,
): Promise<RouteProbeOutcome> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const socket = connect({ hostname: req.address ?? req.host, port: req.port })
  // The timeout leg wins the race on a hanging connect, which leaves `opened` to reject later with
  // nobody awaiting it. In workerd that is an unhandled rejection, and an unhandled rejection is
  // how a diagnostic comes to kill the isolate serving the run it was diagnosing. Observed here so
  // it is always handled; the race below still decides the answer.
  void socket.opened.then(undefined, () => undefined)
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('route probe timed out'))
      }, req.timeoutMs)
    })
    await Promise.race([socket.opened, deadline])
    return { state: 'carried' }
  } catch (error) {
    return classify(error, timedOut)
  } finally {
    if (timer) clearTimeout(timer)
    try {
      await socket.close()
    } catch {
      // The connection is already dead on every failure path, and a close fault has nothing to add
      // and nobody to add it to: this port promises it never rejects.
    }
  }
}
