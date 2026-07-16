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
// Only the OUTBOUND (publish) leg is implemented in this slice. The INBOUND (subscribe) leg — the
// local node receiving org events raised ON the mothership / by peer laptops and re-broadcasting them
// to the laptop's SPA — is a distinct, runtime-shaped follow-up (see the tracker), so `start`/`stop`
// are no-ops here: publishing is a stateless fire-and-forget HTTP POST that needs no live connection
// (unlike the Redis adapter, which must connect before it can publish).

/**
 * A {@link WebSocketPropagator} whose "peer" is the hosted mothership: it forwards each locally
 * originated event to the mothership over the machine-authed `POST /internal/events/publish`
 * ({@link MachineEventClient}). Publish is best-effort and non-blocking — a mothership hiccup must
 * never break a state transition (the event already reached the laptop's own SPA via the layered
 * hub, and the mothership reconciles its clients on reconnect).
 */
export class MothershipWebSocketPropagator implements WebSocketPropagator {
  readonly name = 'mothership'

  constructor(private readonly client: MachineEventClient) {}

  publish(message: RealtimeMessage): void {
    this.client.publish({
      workspaceId: message.workspaceId,
      payload: message.payload,
      originConnectionId: message.originConnectionId ?? null,
    })
  }

  // The subscribe leg is not part of this (outbound) slice, so there is nothing to connect or
  // release. `LayeredEventPropagator.start` still calls this (with a deliver callback we ignore) —
  // a no-op keeps the layer's lifecycle uniform for when the inbound leg lands.
  async start(_deliver: (message: RealtimeMessage) => void): Promise<void> {}

  async stop(): Promise<void> {}
}
