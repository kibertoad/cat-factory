import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  QWEN_BASE_URL,
} from '@cat-factory/agents'
import {
  type GitHubBackfillScheduler,
  type GitHubWebhookIngest,
  type LlmUpstream,
  type LlmUpstreamEndpoint,
  type RealtimeGateway,
  type RuntimeGateways,
  createWebSearchUpstreamFromEnv,
} from '@cat-factory/server'

// Node implementations of the runtime gateway seams. Async GitHub ingest still falls
// back to the "inline / not enabled" paths the shared controllers handle, and the LLM
// proxy forwards to OpenAI-compatible providers over HTTP (no in-process binding).
//
// Real-time delivery, by contrast, IS implemented — but NOT through this gateway seam.
// The seam returns a Hono `Response` (the Cloudflare model: a 101 from the per-workspace
// Durable Object). `@hono/node-server` can't complete a WebSocket upgrade from a
// `Response`, so the Node facade intercepts the `/workspaces/:ws/events` upgrade on the
// HTTP server directly (see `attachRealtime` in `realtime.ts`) before it reaches this
// controller. This gateway therefore stays a no-op: it is never invoked for an actual
// upgrade on Node, and the shared events route only ever falls through to its 426/501.
//
// Production swap-in for a multi-replica deployment (follow-up): front the in-process
// `NodeRealtimeHub` with a shared bus (Postgres LISTEN/NOTIFY); single-process Node and
// local mode need nothing more. Async GitHub ingest: pg-boss `githubBackfill` / `githubWebhook`.

/**
 * No-op: Node handles the WebSocket upgrade at the HTTP-server level (`attachRealtime`),
 * not through this Response-returning seam — see the file header. Returning null keeps
 * the shared controller's contract intact for the (unreachable on Node) delegation path.
 */
class NodeRealtimeGateway implements RealtimeGateway {
  upgrade(): Promise<Response | null> {
    return Promise.resolve(null)
  }
}

/** No async backfill scheduler yet: report "not scheduled" so the caller runs it inline. */
class InlineGitHubBackfillScheduler implements GitHubBackfillScheduler {
  scheduleBackfill(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

/** No async queue yet: report "not queued" so the caller handles webhooks/resyncs inline. */
class InlineGitHubWebhookIngest implements GitHubWebhookIngest {
  enqueueWebhook(): Promise<boolean> {
    return Promise.resolve(false)
  }

  queueRepoResync(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

// `baseUrl` is the built-in default; LiteLLM has none (operator-hosted), so it relies
// purely on its env override and resolves to null until LITELLM_BASE_URL is set.
const OPENAI_COMPATIBLE: Record<string, { baseUrl?: string; baseUrlEnv: string }> = {
  qwen: { baseUrl: QWEN_BASE_URL, baseUrlEnv: 'QWEN_BASE_URL' },
  deepseek: { baseUrl: DEEPSEEK_BASE_URL, baseUrlEnv: 'DEEPSEEK_BASE_URL' },
  moonshot: { baseUrl: MOONSHOT_BASE_URL, baseUrlEnv: 'MOONSHOT_BASE_URL' },
  openai: { baseUrl: OPENAI_BASE_URL, baseUrlEnv: 'OPENAI_BASE_URL' },
  openrouter: { baseUrl: OPENROUTER_BASE_URL, baseUrlEnv: 'OPENROUTER_BASE_URL' },
  litellm: { baseUrlEnv: 'LITELLM_BASE_URL' },
}

/**
 * Forwards the container LLM proxy to OpenAI-compatible providers over HTTP. Only the
 * base URL is resolved here (overridable per provider via env); the API key is leased
 * per call from the DB-backed pool by the proxy. There is no in-process path on Node,
 * so `runInProcess` returns null (a `workers-ai`-pinned model is unavailable here; use
 * a direct provider, or enable the Cloudflare REST flavour).
 */
class HttpLlmUpstream implements LlmUpstream {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  resolveOpenAiCompatible(provider: string): LlmUpstreamEndpoint | null {
    const entry = OPENAI_COMPATIBLE[provider]
    if (!entry) return null
    // `||` not `??`: a set-but-blank base-URL env must fall back to the default, not
    // collapse to an empty URL the SDK then chokes on. For a provider with no default
    // (LiteLLM), an unset env yields null so the proxy reports "not available" cleanly.
    const baseURL = this.env[entry.baseUrlEnv] || entry.baseUrl
    return baseURL ? { baseURL } : null
  }

  runInProcess(): Promise<Response> | null {
    return null
  }
}

/** Build the Node runtime gateways from process env. */
export function createNodeGateways(env: NodeJS.ProcessEnv): RuntimeGateways {
  return {
    realtime: new NodeRealtimeGateway(),
    githubBackfill: new InlineGitHubBackfillScheduler(),
    githubWebhook: new InlineGitHubWebhookIngest(),
    llmUpstream: new HttpLlmUpstream(env),
    // Container web-search proxy upstream (Brave / self-hosted SearXNG from env);
    // absent ⇒ the `/v1/web-search` route 503s and container web search stays off.
    webSearch: createWebSearchUpstreamFromEnv(env),
  }
}
