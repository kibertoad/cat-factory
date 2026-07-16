// Mothership-mode real-time UPSTREAM publish (docs/initiatives/mothership-mode.md, PR 2).
//
// A mothership-mode local node runs the engine on the laptop, but its org/durable state lives
// on the hosted mothership. Its engine events (a run advancing, a board change, a notification)
// must therefore also reach the MOTHERSHIP's real-time fan-out, so a hosted teammate watching the
// same shared board sees the local node's activity live. This module is the runtime-neutral spine
// of that upstream channel — the wire envelope, the mothership-side delivery seam, and the
// fetch-based client the laptop posts through.
//
// It is the deliberate counterpart to the persistence RPC (`/internal/persistence`): the ADR
// (0009) records that cross-cutting concerns — real-time, email, Slack, telemetry — are delegated
// over their OWN `/internal/*` endpoints rather than falling out of the persistence proxy. This is
// the first of those. Same machine-token audience, same both-facades symmetry, same default-deny
// account scoping.
//
// Direction: this slice covers the OUTBOUND half (laptop → mothership → the mothership's own
// realtime consumers). The INBOUND half (the local node subscribing to org events raised on the
// mothership / by peer laptops) is a distinct, runtime-shaped follow-up — see the tracker.

/**
 * One real-time event relayed from a mothership-mode node to the mothership. `payload` is the
 * exact JSON text frame a subscribed browser receives (a serialized `WorkspaceEvent`, produced by
 * the publisher on the origin node) — the mothership never re-parses it, it just fans the opaque
 * frame to its own realtime consumers. `originConnectionId` carries the `?cid=` of the connection
 * that caused a board mutation so the mothership can suppress the echo to that socket (harmless on
 * the mothership — it simply won't hold that laptop-local connection).
 *
 * Structurally identical to the Node facade's `RealtimeMessage`; kept as its own type here so the
 * shared wire contract lives below kernel with the controller + client that speak it.
 */
export interface RelayedRealtimeEvent {
  workspaceId: string
  payload: string
  originConnectionId?: string | null
}

/**
 * The mothership-side delivery seam for a relayed real-time event: a facade acting as a MOTHERSHIP
 * attaches this so the shared `/internal/events/publish` controller can inject a laptop's event into
 * this deployment's OWN real-time fan-out. Each facade supplies its differentiator — the Node hub /
 * cross-node propagator on Node, the per-workspace `WorkspaceEventsHub` Durable Object on Cloudflare
 * — behind this one method, exactly as `RealtimeGateway.upgrade` abstracts the consumer side.
 *
 * `ingest` delivers to THIS deployment's consumers only (its browsers, and its own cross-replica
 * bus where one exists); it must NOT itself re-relay upstream, so it can never loop. That holds by
 * construction: only a mothership deployment ever receives a `/internal/events/publish` call, and a
 * mothership's realtime sink fans to its hub + (optionally) a peer bus like Redis — never back to a
 * laptop, which is not on that bus.
 */
export interface MachineEventRelay {
  /**
   * Inject a relayed event into this mothership's real-time fan-out, scoped to `event.workspaceId`.
   * Best-effort: a delivery failure must never fail the caller (the persisted row is the source of
   * truth and clients reconcile on reconnect), so implementations swallow their own errors.
   */
  ingest(event: RelayedRealtimeEvent): void | Promise<void>
}

/** The client half: posts a relayed event to a mothership's `/internal/events/publish`. */
export interface MachineEventClient {
  /**
   * Forward one relayed event to the mothership. Best-effort and non-blocking — it never throws
   * and never blocks a state transition (fire-and-forget); a drop is reconciled by the client's
   * reconnect-resync, exactly like the Redis propagator's publish.
   */
  publish(event: RelayedRealtimeEvent): void
}

/**
 * A fetch-based {@link MachineEventClient} that posts to a mothership's `POST /internal/events/publish`,
 * presenting the node's machine token. Mirrors {@link HttpPersistenceRpcClient}'s auth contract (a
 * fixed token OR a per-request provider, so a token cached after boot by the mothership login flow is
 * picked up without a restart). Fire-and-forget: the returned promise is consumed internally and any
 * error is swallowed — the event was already delivered to the node's own browsers, and the mothership
 * reconciles on reconnect if this drops.
 */
export class HttpMachineEventClient implements MachineEventClient {
  constructor(
    private readonly opts: {
      baseUrl: string
      /** The machine token, as a fixed string OR a provider read per request (may return null). */
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  publish(event: RelayedRealtimeEvent): void {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    // No token yet (a node booted before the mothership login) ⇒ skip the round-trip entirely; the
    // event still reached this node's local browsers. Avoids a guaranteed-403 POST per event.
    if (!token) return
    void fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/internal/events/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        workspaceId: event.workspaceId,
        payload: event.payload,
        ...(event.originConnectionId ? { originConnectionId: event.originConnectionId } : {}),
      }),
    }).catch(() => {
      // Best-effort: a publish failure must never break the state transition that produced the
      // event. The local hub already delivered to this node's browsers; the mothership reconciles
      // its own clients on reconnect if this drops.
    })
  }
}
