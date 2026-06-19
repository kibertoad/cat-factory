// Runtime "gateway" seams: the differentiator capabilities a controller needs but
// that are implemented differently per facade. They are carried on the request
// container (`container.gateways`) so the shared controllers stay free of any
// runtime binding (`c.env`), and each facade supplies its own implementation —
// Durable Objects / Workflows / Queues on the Cloudflare Worker, a WebSocket hub /
// pg-boss on the Node service.

/**
 * Real-time event delivery to a connected browser. The engine pushes events via the
 * `ExecutionEventPublisher` port; this is the consumer side — accepting a WebSocket
 * upgrade for a workspace's stream.
 */
export interface RealtimeGateway {
  /**
   * Handle a WebSocket upgrade for `workspaceId`'s event stream, returning the
   * upgrade `Response`, or `null` when real-time delivery is not enabled in this
   * deployment (the controller then replies 501).
   */
  upgrade(workspaceId: string, request: Request): Promise<Response | null>
}

/** The bundle of runtime gateways a facade injects onto every request container. */
export interface RuntimeGateways {
  realtime: RealtimeGateway
}
