import type { MachineEventRelay, RelayedRealtimeEvent } from '@cat-factory/server'
import type { LocalEventSink } from './realtime.js'

// The Node facade's mothership-side real-time UPSTREAM delivery (docs/initiatives/mothership-mode.md,
// PR 2). When this deployment acts as a MOTHERSHIP, a machine-authed mothership-mode node POSTs its
// engine events to `/internal/events/publish`; the shared controller hands each one here so it lands
// in this deployment's OWN real-time fan-out. The Cloudflare analogue publishes to the per-workspace
// WorkspaceEventsHub Durable Object — this is the symmetric Node implementation.

/**
 * Delivers a relayed real-time event into the Node facade's own real-time fan-out — the same
 * {@link LocalEventSink} the engine's {@link NodeEventPublisher} writes through. On a single-node
 * mothership that is the bare {@link NodeRealtimeHub} (its connected browsers); on a horizontally
 * scaled mothership it is the {@link LayeredEventPropagator}, so a laptop's event ALSO fans to peer
 * replicas over the cross-node bus (Redis) and reaches browsers attached to any of them.
 *
 * It cannot loop: this relay is only ever reached on a MOTHERSHIP (a laptop is never POSTed to), and
 * a mothership's sink fans to its hub + a peer bus like Redis — never back to a laptop, which is not
 * on that bus. The event's `originConnectionId` (a laptop-local `?cid=`) is passed through so a
 * browser that happens to reuse the same id doesn't refresh off the echo; harmless here since the
 * mothership doesn't hold that laptop-local connection.
 */
export class LocalMachineEventRelay implements MachineEventRelay {
  constructor(private readonly sink: LocalEventSink) {}

  ingest(event: RelayedRealtimeEvent): void {
    try {
      this.sink.broadcast(event.workspaceId, event.payload, event.originConnectionId ?? null)
    } catch {
      // Best-effort delivery: a broadcast hiccup must never fail the relayed publish. The
      // persisted row is the source of truth; the mothership's clients reconcile on reconnect.
    }
  }
}
