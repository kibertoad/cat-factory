import type { MachineEventRelay, RelayedRealtimeEvent } from '@cat-factory/server'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { WorkspaceEventsHub } from '../durable-objects/WorkspaceEventsHub'

/**
 * The Cloudflare facade's mothership-side real-time UPSTREAM delivery (docs/initiatives/mothership-mode.md,
 * PR 2). When this Worker acts as a MOTHERSHIP, a machine-authed mothership-mode node POSTs its engine
 * events to `/internal/events/publish`; the shared controller hands each one here, and it is injected
 * into the per-workspace {@link WorkspaceEventsHub} Durable Object — exactly the sink the Worker's own
 * {@link DurableObjectEventPublisher} publishes to — which fans it out to that workspace's subscribed
 * browsers. The Node analogue delivers through the in-process hub / propagator; this is the symmetric
 * Cloudflare implementation.
 *
 * The relayed `payload` is already the serialized `WorkspaceEvent` frame the hub broadcasts verbatim,
 * so it is forwarded as-is (never re-parsed). `originConnectionId` rides as the `X-Origin-Cid`
 * side-channel header so the hub can suppress the echo to a matching socket, identical to the Worker's
 * own publisher. Because the hub Durable Object is globally addressed (one per workspace across the
 * whole deployment), a single POST reaches every browser regardless of which isolate holds it — so no
 * cross-node propagation is needed here.
 */
export class DurableObjectMachineEventRelay implements MachineEventRelay {
  constructor(private readonly namespace: DurableObjectNamespace<WorkspaceEventsHub>) {}

  async ingest(event: RelayedRealtimeEvent): Promise<void> {
    try {
      const stub = this.namespace.get(this.namespace.idFromName(event.workspaceId))
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (event.originConnectionId) headers['X-Origin-Cid'] = event.originConnectionId
      await stub.fetch('http://hub/publish', { method: 'POST', headers, body: event.payload })
    } catch {
      // No subscribers / transient DO error — best-effort by contract. The persisted row is the
      // source of truth and the mothership's clients reconcile any missed event on reconnect.
    }
  }
}
