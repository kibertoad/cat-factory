/**
 * Open a bounded TCP connection to one target and say what happened, so the platform can PROVE a
 * route instead of asserting one.
 *
 * A port rather than a helper because both facades can do this and neither does it the same way:
 * Node opens a `net.Socket`, the Worker opens a `cloudflare:sockets` connection. It is deliberately
 * NOT an HTTP request. The question is whether packets get there, and an HTTP status is the layer
 * ABOVE that: the incident this exists for had a load balancer answering 503 over a route that
 * worked perfectly, and reading that as unreachable would have mislabelled the one fact the tester
 * needed. Proving the transport and observing the application stay separate jobs.
 *
 * Nothing here is on the container-dispatch path. The bridge classifier stays syntactic with no
 * lookup for the reasons stated in `shared/environment-host-bridge.logic.ts`; this runs once, in
 * the deployer's settle path, where the I/O is free and a slow answer costs nobody a step.
 */
export interface RouteProbeRequest {
  /**
   * The name the environment's URL carries. Kept even when {@link address} is set, because a
   * bridge preserves it: the whole point of mapping a name to an address rather than rewriting
   * the URL is that the `Host` header a name-based ingress routes on stays correct.
   */
  host: string
  /**
   * Dial this instead of resolving {@link host}. Absent means resolve the name, which is the
   * first thing every proof tries.
   */
  address?: string
  port: number
  /** Give up after this long. A route that has not answered by then is the failure being looked for. */
  timeoutMs: number
}

/**
 * What one probe found, at the layer a TCP connect can observe.
 *
 * Separate members rather than an `ok` boolean because the failures need different reactions and
 * name different owners, and because a connection failure that renders as one undifferentiated
 * symptom is the exact defect this port exists to retire. The mapping onto the user-facing
 * vocabulary is `EnvironmentUnreachableReason`, one member each.
 */
export type RouteProbeOutcome =
  /** The connection opened. Nothing is claimed about what is listening there. */
  | { state: 'carried' }
  /** The name resolved nowhere. */
  | { state: 'unresolved' }
  /** Something resolved and the connect never completed: a timeout, or no route to the host. */
  | { state: 'no_route' }
  /** The route carries and nothing is listening on the port. */
  | { state: 'refused' }
  /** The probe itself failed in a way it could not classify. Never a verdict about the target. */
  | { state: 'failed'; detail: string }

/**
 * Probe one target. Resolves with an outcome for every case including failure, and NEVER rejects:
 * a thrown probe would turn a diagnostic into a second way for a healthy run to die, and the
 * `failed` member is what says "we could not tell" honestly.
 */
export type RouteProbe = (req: RouteProbeRequest) => Promise<RouteProbeOutcome>
