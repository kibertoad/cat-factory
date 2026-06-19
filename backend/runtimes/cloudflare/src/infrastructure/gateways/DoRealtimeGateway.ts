import type { RealtimeGateway } from '@cat-factory/server'
import type { DurableObjectNamespace } from '@cloudflare/workers-types'
import type { WorkspaceEventsHub } from '../durable-objects/WorkspaceEventsHub'

/**
 * Worker implementation of the realtime gateway: forwards a WebSocket upgrade to the
 * per-workspace {@link WorkspaceEventsHub} Durable Object, which holds the socket
 * (hibernatable) and broadcasts the events the engine publishes. Returns null when
 * no `WORKSPACE_EVENTS` namespace is bound, so the controller replies 501.
 */
export class DoRealtimeGateway implements RealtimeGateway {
  constructor(private readonly namespace?: DurableObjectNamespace<WorkspaceEventsHub>) {}

  async upgrade(workspaceId: string, request: Request): Promise<Response | null> {
    if (!this.namespace) return null
    const stub = this.namespace.get(this.namespace.idFromName(workspaceId))
    // Forward the original request so the 101 + live `webSocket` flows back out.
    return stub.fetch(request as unknown as Parameters<typeof stub.fetch>[0]) as unknown as Response
  }
}
