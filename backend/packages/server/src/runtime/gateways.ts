import type { Logger } from '../observability/logger.js'

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

/** OpenAI-style token usage scraped from an upstream completion, for spend metering. */
export interface LlmTokenUsage {
  prompt_tokens?: number
  completion_tokens?: number
}

/**
 * What an upstream path (HTTP buffered/streamed, or an in-process gateway) reports
 * back to the proxy for observability once a call resolves. The proxy supplies the
 * request-side fields (prompt, correlation, total timing); this is the response side.
 */
export interface ProxyCallObservation {
  usage: LlmTokenUsage | null
  /** Prompt tokens served from the provider's cache (subset of usage.prompt_tokens); 0 if none. */
  cachedPromptTokens?: number
  /** Upstream finish reason (`stop` | `length` | `tool_calls` | `content_filter` | …). */
  finishReason: string | null
  /** The assistant response text (concatenated for streamed calls). */
  responseText: string
  ok: boolean
  httpStatus: number | null
  errorMessage: string | null
  /** Time spent waiting on the model (ms) — measured by the path that made the call. */
  upstreamMs: number
}

/** A resolved OpenAI-compatible upstream: where to forward, and the key to use. */
export interface LlmUpstreamEndpoint {
  baseURL: string
  apiKey: string
}

/** What the LLM proxy needs to run a model in-process (e.g. a Workers AI binding). */
export interface LlmInProcessRequest {
  /** Locked model id. */
  model: string
  /** The (hardened) OpenAI Chat Completions request body. */
  payload: Record<string, unknown>
  streaming: boolean
  /** Meter token usage into the spend ledger. */
  record: (usage: LlmTokenUsage | null) => Promise<number>
  /**
   * Report the call's full observation (usage + finish reason + response text +
   * model timing) for the observability sink. Optional and a no-op when the sink
   * is not wired; the gateway should call it once the completion resolves.
   */
  recordMetric?: (observation: ProxyCallObservation) => void
  /** Schedule post-response work (CF `waitUntil`; a no-op fire-and-forget on Node). */
  waitUntil: (p: Promise<unknown>) => void
  /** Correlated logger for this proxied call. */
  log: Logger
}

/**
 * The provider side of the container LLM proxy. The shared controller owns session
 * verification, the spend gate, request hardening and the OpenAI-compatible HTTP
 * forward path + metering; this gateway supplies the runtime-specific bits: where an
 * OpenAI-compatible provider lives (base URL + key), and an optional in-process path
 * for providers reached through a binding (Cloudflare Workers AI on the Worker; none
 * on Node, which forwards over HTTP instead).
 */
export interface LlmUpstream {
  /** Resolve an OpenAI-compatible upstream for `provider`, or null when unavailable. */
  resolveOpenAiCompatible(provider: string): LlmUpstreamEndpoint | null
  /**
   * Serve a completion in-process (no external HTTP), returning an OpenAI-shaped
   * Response — or null when this runtime has no in-process path (the controller then
   * replies 502 for a provider that requires it, e.g. `workers-ai`).
   */
  runInProcess(request: LlmInProcessRequest): Promise<Response> | null
}

/** The bundle of runtime gateways a facade injects onto every request container. */
export interface RuntimeGateways {
  realtime: RealtimeGateway
  githubBackfill: GitHubBackfillScheduler
  githubWebhook: GitHubWebhookIngest
  llmUpstream: LlmUpstream
}
