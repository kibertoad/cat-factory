import type { MachineEventClient } from '@cat-factory/server'
import type { RealtimeMessage, WebSocketPropagator } from '@cat-factory/node-server'

// Mothership-mode real-time UPSTREAM propagation (docs/initiatives/mothership-mode.md, PR 2).
//
// A mothership-mode local node keeps org/durable state on the mothership, but runs the engine on
// the laptop — so its engine events must ALSO reach the mothership's real-time fan-out, or a hosted
// teammate watching the same shared board never sees the local node's activity. This adapter carries
// that upstream leg.
//
// It reuses the EXISTING cross-node real-time seam ({@link WebSocketPropagator} — the same port the
// Redis adapter implements), NOT a bespoke publisher: the mothership is conceptually just another
// propagation target, so the local node's realtime sink is a {@link LayeredEventPropagator} whose one
// adapter is this. `LayeredEventPropagator.broadcast` already fans every engine event to the local hub
// (the laptop's own SPA) AND to each adapter's `publish` — so wiring this adapter makes the local
// node's events reach the laptop's browser AND the mothership with no engine change.
//
// This adapter carries the OUTBOUND (publish) leg only. Its INBOUND counterpart is
// {@link MothershipEventSubscriber}, which is NOT expressed through this port on purpose: a
// cross-node adapter's `start(deliver)` receives no workspace list, while the mothership's inbound
// streams are per-workspace and opened on demand from the local hub's rooms. Forcing it through
// `start` would mean either subscribing to nothing or inventing a workspace enumeration the node
// doesn't have. So `start`/`stop` stay no-ops here — publishing is a stateless fire-and-forget HTTP
// POST needing no live connection (unlike the Redis adapter, which must connect before it can
// publish).

/**
 * A {@link WebSocketPropagator} whose "peer" is the hosted mothership: it forwards each locally
 * originated event to the mothership over the machine-authed `POST /internal/events/publish`
 * ({@link MachineEventClient}). Publish is best-effort and non-blocking — a mothership hiccup must
 * never break a state transition (the event already reached the laptop's own SPA via the layered
 * hub, and the mothership reconciles its clients on reconnect).
 */
export class MothershipWebSocketPropagator implements WebSocketPropagator {
  readonly name = 'mothership'

  /**
   * `connectionId` is this NODE's stable id — the same `?cid=` its inbound subscriptions connect
   * with. Stamping it on every publish is what stops the mothership fanning our own events back
   * down our own subscription, where they would reach the laptop's browsers a second time.
   */
  constructor(
    private readonly client: MachineEventClient,
    private readonly connectionId: string,
  ) {}

  publish(message: RealtimeMessage): void {
    this.client.publish({
      workspaceId: message.workspaceId,
      payload: message.payload,
      // Deliberately REPLACES the originating tab's `?cid=` rather than passing it through. That
      // id only means something to the sockets of the node that produced the event — all of which
      // are local, and were already served (with correct per-tab echo suppression) by the layered
      // hub before this adapter ran. On the mothership the tab id matches nothing, while OUR id
      // matches the one socket that must not receive this event back.
      originConnectionId: this.connectionId,
    })
  }

  // See the file header: the inbound leg is a per-workspace subscriber, not a propagator adapter.
  // `LayeredEventPropagator.start` still calls this (with a deliver callback we ignore) — a no-op
  // keeps the layer's lifecycle uniform.
  async start(_deliver: (message: RealtimeMessage) => void): Promise<void> {}

  async stop(): Promise<void> {}
}
