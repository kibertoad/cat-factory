import type { InputTokenClasses } from '@cat-factory/agents'
import type { WebSearchProvider } from '@cat-factory/contracts'
import type { TrackerWebhookEvent } from '@cat-factory/kernel'
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
  /**
   * Enqueue a targeted skill-source resync — the push-webhook freshness fan-out (slice 4).
   * When a push advances a repo that skill sources are linked to, the async consumer re-syncs
   * each affected source so its skills stay current. `false` (no queue bound: local/dev/tests)
   * means the fan-out is skipped; freshness is then guaranteed at dispatch by the resolver's
   * head-commit probe rather than proactively here.
   */
  queueSkillResync(accountId: string, sourceId: string): Promise<boolean>
  /**
   * The same fan-out for a repo-sourced FOUNDATIONAL-SERVICE source. Keyed on the source id
   * alone: the source's owning tier is a stored field, and the consumer resolves it there rather
   * than trusting a copy that rode the queue.
   */
  queueFoundationalResync(sourceId: string): Promise<boolean>
}

/**
 * Hands a VERIFIED inbound tracker delivery to an async consumer so the receiver can ack fast —
 * the task-source analogue of {@link GitHubWebhookIngest}, and wired the same way: a Cloudflare
 * Queue on the Worker, a pg-boss queue on Node, and `false` when neither is bound so the caller
 * applies it inline (local/dev/tests).
 *
 * The delivery is passed as the already-PARSED neutral event rather than the raw payload, because
 * verification and parsing both need the provider — which the receiver has resolved and the
 * consumer would otherwise have to resolve again. A queued job therefore carries no secret and no
 * vendor shape, only `(workspace, event)`.
 */
export interface TrackerWebhookIngest {
  /** Enqueue a verified tracker event for async handling. `false` ⇒ handle it inline. */
  enqueueEvent(workspaceId: string, event: TrackerWebhookEvent): Promise<boolean>
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
  /**
   * The call's three input classes (fresh + both cache classes, additive), when the upstream
   * path already knows them apart. Omit and the proxy derives all three from `usage` via
   * `readInputTokenClasses`, which reconciles the inclusive (OpenAI/DeepSeek) and exclusive
   * (Anthropic) provider shapes.
   *
   * All three travel together on purpose: `fresh` is only meaningful relative to the classes
   * subtracted from it, so a path that supplied the cache classes alone would leave the proxy
   * re-deriving `fresh` from a payload whose shape it just overrode.
   */
  inputTokens?: InputTokenClasses
  /** Upstream finish reason (`stop` | `length` | `tool_calls` | `content_filter` | …). */
  finishReason: string | null
  /** The assistant response text (concatenated for streamed calls). */
  responseText: string
  /**
   * The model's reasoning / "thinking" trace, when it emits one on a separate channel
   * (AI SDK `reasoningText`; OpenAI-compatible `reasoning_content` / `reasoning`).
   * Absent/empty for non-reasoning models. Lets the sink record a thinking turn whose
   * `responseText` came back empty so its output tokens are still accounted for.
   */
  reasoningText?: string
  ok: boolean
  httpStatus: number | null
  errorMessage: string | null
  /** Time spent waiting on the model (ms) — measured by the path that made the call. */
  upstreamMs: number
}

/**
 * A resolved OpenAI-compatible upstream: where to forward. The API key is NOT here —
 * it is leased per call from the DB-backed API-key pool by the proxy, so credentials
 * are no longer env-baked into the gateway.
 */
export interface LlmUpstreamEndpoint {
  baseURL: string
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
  /**
   * Resolve the OpenAI-compatible base URL for `provider`, or null when unavailable.
   * Key-free: the proxy leases the API key from the DB pool and injects it.
   */
  resolveOpenAiCompatible(provider: string): LlmUpstreamEndpoint | null
  /**
   * Serve a completion in-process (no external HTTP), returning an OpenAI-shaped
   * Response — or null when this runtime has no in-process path (the controller then
   * replies 502 for a provider that requires it, e.g. `workers-ai`).
   */
  runInProcess(request: LlmInProcessRequest): Promise<Response> | null
}

/** One web-search hit, normalised to the SearXNG result shape Pi's web tools read. */
export interface WebSearchResult {
  /** Result page URL. */
  url: string
  /** Result title. */
  title: string
  /** Snippet/description (SearXNG's `content` field). */
  content: string
}

/** A normalised web-search response (the subset the container's SearXNG client reads). */
export interface WebSearchResponse {
  /** Echo of the query, as SearXNG returns it. */
  query: string
  results: WebSearchResult[]
}

/**
 * The backend side of the CONTAINER web-search proxy: the seam that keeps a
 * search-provider key out of the sandbox the same way `LlmUpstream` keeps model
 * keys out. The container's Pi `web_search` tool (rpiv-web-tools, SearXNG provider)
 * is pointed at `${proxyBaseUrl}/web-search` with its per-job session token as the
 * bearer; the shared `webSearchProxyController` verifies that token and delegates to
 * this gateway, which performs the actual search server-side under the deployment's
 * own provider key. Absent ⇒ the proxy route is not enabled (no container web search).
 */
export interface WebSearchUpstream {
  /** Which backend serves this upstream, surfaced on the run details + search telemetry. */
  readonly provider: WebSearchProvider
  /** Run a web search server-side, returning results in the normalised shape. */
  search(query: string, opts?: { count?: number; signal?: AbortSignal }): Promise<WebSearchResponse>
}

/** The bundle of runtime gateways a facade injects onto every request container. */
export interface RuntimeGateways {
  realtime: RealtimeGateway
  githubBackfill: GitHubBackfillScheduler
  githubWebhook: GitHubWebhookIngest
  /**
   * Async hand-off for inbound TRACKER deliveries. Required (not optional) so a facade cannot
   * quietly omit it and leave the receiver blocking the tracker on the whole handle — a facade
   * with no queue supplies the INLINE seam, which is an explicit choice rather than an absence.
   */
  trackerWebhook: TrackerWebhookIngest
  llmUpstream: LlmUpstream
}
