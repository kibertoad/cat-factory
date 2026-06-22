import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
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

// Node implementations of the runtime gateway seams. This MVP keeps them simple and
// dependency-free: real-time delivery and async GitHub ingest fall back to the
// "inline / not enabled" paths the shared controllers already handle, and the LLM
// proxy forwards to OpenAI-compatible providers over HTTP (no in-process binding).
//
// Production swap-ins (follow-ups): a WebSocket hub (Postgres LISTEN/NOTIFY) for
// `realtime`, and pg-boss-backed `githubBackfill` / `githubWebhook`.

/** No real-time transport yet: the events route replies 501 and clients reconcile on poll. */
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

const OPENAI_COMPATIBLE: Record<string, { baseUrl: string; baseUrlEnv: string }> = {
  qwen: { baseUrl: QWEN_BASE_URL, baseUrlEnv: 'QWEN_BASE_URL' },
  deepseek: { baseUrl: DEEPSEEK_BASE_URL, baseUrlEnv: 'DEEPSEEK_BASE_URL' },
  moonshot: { baseUrl: MOONSHOT_BASE_URL, baseUrlEnv: 'MOONSHOT_BASE_URL' },
  openai: { baseUrl: OPENAI_BASE_URL, baseUrlEnv: 'OPENAI_BASE_URL' },
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
    // collapse to an empty URL the SDK then chokes on.
    return { baseURL: this.env[entry.baseUrlEnv] || entry.baseUrl }
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
