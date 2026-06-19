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

/**
 * Schedules a durable, full-installation GitHub backfill out of band. On the Worker
 * this is a Cloudflare Workflow; on Node a pg-boss job. The boolean lets the caller
 * preserve its response semantics (async "started" vs running it inline).
 */
export interface GitHubBackfillScheduler {
  /** Kick a full-installation backfill. `true` = scheduled async; `false` = run it inline. */
  scheduleBackfill(installationId: number): Promise<boolean>
}

/**
 * Hands GitHub sync work to an async consumer so the request can ack fast. On the
 * Worker this is a Queue; on Node a pg-boss queue. Each method returns whether the
 * work was enqueued; when `false`, the caller runs it inline (e.g. local/dev).
 */
export interface GitHubWebhookIngest {
  /** Enqueue a verified webhook delivery for async projection. */
  enqueueWebhook(eventName: string, payload: unknown): Promise<boolean>
  /** Enqueue an incremental single-repo resync. */
  queueRepoResync(workspaceId: string, repoGithubId: number): Promise<boolean>
}

/** The bundle of runtime gateways a facade injects onto every request container. */
export interface RuntimeGateways {
  realtime: RealtimeGateway
  githubBackfill: GitHubBackfillScheduler
  githubWebhook: GitHubWebhookIngest
}
