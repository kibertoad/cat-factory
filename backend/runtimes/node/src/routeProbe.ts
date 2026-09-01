import { connect, type Socket } from 'node:net'
import type { RouteProbe, RouteProbeOutcome, RouteProbeRequest } from '@cat-factory/kernel'

// The Node facade's `RouteProbe`: one bounded TCP connect, classified by what the socket said.
//
// A raw socket rather than a `fetch` because the question is whether packets get there. The
// incident this exists for had a load balancer answering 503 over a route that worked perfectly,
// and reading an HTTP status as the transport verdict would have mislabelled the one fact the
// tester needed. See `kernel/src/ports/route-probe.ts`.

/**
 * Map a `net` error onto the probe vocabulary.
 *
 * `ENOTFOUND`/`EAI_AGAIN` are the resolver saying nothing, which is the case an address bridge
 * exists to work around. `ETIMEDOUT`/`EHOSTUNREACH`/`ENETUNREACH` are a name that resolved and a
 * route that does not carry, which is the expensive failure: a lookup that worked followed by a
 * connect that hangs. `ECONNREFUSED` reaches the box and finds nothing listening, which is the
 * deployed workload rather than the network. Anything else is reported as a probe malfunction
 * rather than squeezed into one of those, because a wrong layer is worse than no layer.
 */
function classify(error: NodeJS.ErrnoException): RouteProbeOutcome {
  switch (error.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { state: 'unresolved' }
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { state: 'no_route' }
    case 'ECONNREFUSED':
      return { state: 'refused' }
    default:
      return { state: 'failed', detail: error.code ?? error.message }
  }
}

/**
 * Open a socket to the request's target and resolve with what happened, never rejecting.
 *
 * The socket is destroyed on every exit path including the success one: the probe wants the
 * three-way handshake and nothing after it, and leaving a connection open against an operator's
 * balancer for the sake of a diagnostic would be its own small leak. Settling is latched, because
 * a socket can emit `error` after a timeout has already destroyed it.
 */
export const nodeRouteProbe: RouteProbe = (req: RouteProbeRequest) =>
  new Promise<RouteProbeOutcome>((resolve) => {
    let settled = false
    let socket: Socket | undefined
    const finish = (outcome: RouteProbeOutcome) => {
      if (settled) return
      settled = true
      socket?.destroy()
      resolve(outcome)
    }
    // `connect` validates its arguments SYNCHRONOUSLY and throws for a port outside 1-65535 or a
    // host of the wrong shape, and a throw inside this executor is a REJECTED probe. The port
    // promises it never rejects: a caller's best-effort wrapper would swallow that and record no
    // proof at all, where the `failed` member exists to say "we could not tell" on the record.
    try {
      socket = connect({ host: req.address ?? req.host, port: req.port })
    } catch (error) {
      finish(classify(error as NodeJS.ErrnoException))
      return
    }
    socket.setTimeout(req.timeoutMs, () => finish({ state: 'no_route' }))
    socket.once('connect', () => finish({ state: 'carried' }))
    socket.once('error', (error: NodeJS.ErrnoException) => finish(classify(error)))
  })
