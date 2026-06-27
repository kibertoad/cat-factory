import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  QWEN_BASE_URL,
  resolveOpenAiCompatibleBaseUrl,
} from '@cat-factory/agents'
import type { Env } from '../env'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours live in
// the shared AI provisioning facade (@cat-factory/agents) so the Vercel-AI model
// provider (CloudflareModelProvider), the container LLM proxy (LlmProxyController)
// and the Node service all resolve them from one source of truth. This module adds
// the Worker-specific `env` plumbing: each base URL is overridable via env (e.g.
// QWEN_BASE_URL) so a deployment can point a provider at a self-hosted gateway, a
// regional endpoint, or — in the acceptance tests — a local stub, without code changes.
export { DEEPSEEK_BASE_URL, MOONSHOT_BASE_URL, OPENAI_BASE_URL, OPENROUTER_BASE_URL, QWEN_BASE_URL }

/**
 * The effective base URL for a provider: the typed `${PROVIDER}_BASE_URL` env override,
 * else the built-in default. The override-vs-default precedence, the defaults table and
 * the litellm-has-no-default semantics live in @cat-factory/agents so the Node service
 * resolves identically; this only maps the Worker's typed Env fields to that resolver.
 */
export function baseUrlFor(provider: string, env: Env): string | null {
  const override: Record<string, string | undefined> = {
    qwen: env.QWEN_BASE_URL,
    deepseek: env.DEEPSEEK_BASE_URL,
    moonshot: env.MOONSHOT_BASE_URL,
    openai: env.OPENAI_BASE_URL,
    openrouter: env.OPENROUTER_BASE_URL,
    litellm: env.LITELLM_BASE_URL,
  }
  return resolveOpenAiCompatibleBaseUrl(provider, override[provider]) ?? null
}

/** A resolved OpenAI-compatible upstream: where to send the request (key-free). */
export interface UpstreamEndpoint {
  baseURL: string
}

/**
 * Resolve a provider id to its OpenAI-compatible upstream base URL. Returns null for
 * providers that are not OpenAI-compatible (e.g. `workers-ai`, `anthropic`). The API
 * key is leased per call from the DB-backed pool by the proxy — it is no longer read
 * from env here.
 */
export function resolveOpenAiCompatibleUpstream(
  provider: string,
  env: Env,
): UpstreamEndpoint | null {
  const baseURL = baseUrlFor(provider, env)
  if (!baseURL) return null
  return { baseURL }
}
