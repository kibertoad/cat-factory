import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  QWEN_BASE_URL,
} from '@cat-factory/agents'
import type {
  GitHubBackfillScheduler,
  GitHubWebhookIngest,
  LlmUpstream,
  LlmUpstreamEndpoint,
  RealtimeGateway,
  RuntimeGateways,
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

const OPENAI_COMPATIBLE: Record<string, { baseUrl: string; keyEnv: string; baseUrlEnv: string }> = {
  qwen: { baseUrl: QWEN_BASE_URL, keyEnv: 'QWEN_API_KEY', baseUrlEnv: 'QWEN_BASE_URL' },
  deepseek: {
    baseUrl: DEEPSEEK_BASE_URL,
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
  },
  moonshot: {
    baseUrl: MOONSHOT_BASE_URL,
    keyEnv: 'MOONSHOT_API_KEY',
    baseUrlEnv: 'MOONSHOT_BASE_URL',
  },
  openai: { baseUrl: OPENAI_BASE_URL, keyEnv: 'OPENAI_API_KEY', baseUrlEnv: 'OPENAI_BASE_URL' },
}

/**
 * Forwards the container LLM proxy to OpenAI-compatible providers over HTTP, keyed
 * from process env. There is no in-process path on Node, so `runInProcess` returns
 * null (a `workers-ai`-pinned model is unavailable here; use a direct provider or the
 * Cloudflare REST flavour instead).
 */
class HttpLlmUpstream implements LlmUpstream {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  resolveOpenAiCompatible(provider: string): LlmUpstreamEndpoint | null {
    const entry = OPENAI_COMPATIBLE[provider]
    if (!entry) return null
    const apiKey = this.env[entry.keyEnv]
    if (!apiKey) return null
    return { baseURL: this.env[entry.baseUrlEnv] ?? entry.baseUrl, apiKey }
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
  }
}
