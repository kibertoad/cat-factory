import {
  DEEPSEEK_BASE_URL,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  QWEN_BASE_URL,
  isDirectProvider,
  isOpenAiCompatibleProvider,
  resolveOpenAiCompatibleBaseUrl,
  type DirectProvider,
} from '@cat-factory/agents'
import type { Env } from '../env'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours live in
// the shared AI provisioning facade (@cat-factory/agents) so the Vercel-AI model
// provider (CloudflareModelProvider), the container LLM proxy (LlmProxyController)
// and the Node service all resolve them from one source of truth. This module adds
// the Worker-specific `env` plumbing: each base URL is overridable via env (e.g.
// QWEN_BASE_URL) so a deployment can point a provider at a self-hosted gateway, a
// regional endpoint, or, in the acceptance tests, a local stub, without code changes.
export { DEEPSEEK_BASE_URL, MOONSHOT_BASE_URL, OPENAI_BASE_URL, OPENROUTER_BASE_URL, QWEN_BASE_URL }

/**
 * Which `Env` field carries each direct provider's base-URL override.
 *
 * TOTAL over {@link DirectProvider} rather than a loose `Record<string, …>`: `env` is a typed
 * interface, so the field cannot be looked up by name here, and a provider left out reads as "no
 * override configured" forever. That is silent both ways: a documented `${PROVIDER}_BASE_URL` that
 * nothing consumes (`XAI_BASE_URL` was exactly this, and `ANTHROPIC_BASE_URL` was exactly this
 * against the Node facade, which reads env by name and honoured it), and an operator-hosted gateway
 * that can never resolve at all. Adding a member to the shared table now fails to compile until
 * this map answers for it.
 *
 * A map of ACCESSORS built once at module scope, not an object literal built per call: `baseUrlFor`
 * is on the catalog-render and run-start paths (once per configured provider) and on every proxied
 * LLM request, and it needs exactly one of these fields. The accessor shape keeps the compile-time
 * totality that is the whole reason the map exists while reading only the field asked for.
 */
const BASE_URL_OVERRIDE: Record<DirectProvider, (env: Env) => string | undefined> = {
  qwen: (env) => env.QWEN_BASE_URL,
  deepseek: (env) => env.DEEPSEEK_BASE_URL,
  moonshot: (env) => env.MOONSHOT_BASE_URL,
  openai: (env) => env.OPENAI_BASE_URL,
  openrouter: (env) => env.OPENROUTER_BASE_URL,
  xai: (env) => env.XAI_BASE_URL,
  bifrost: (env) => env.BIFROST_BASE_URL,
  litellm: (env) => env.LITELLM_BASE_URL,
  anthropic: (env) => env.ANTHROPIC_BASE_URL,
}

/**
 * The effective base URL for a direct provider: the typed `${PROVIDER}_BASE_URL` env override,
 * else the built-in default. The override-vs-default precedence, the defaults table and the
 * no-public-endpoint semantics of the operator-hosted gateways live in @cat-factory/agents so the
 * Node service resolves identically; this only maps the Worker's typed Env fields to that
 * resolver.
 *
 * `anthropic` is in scope here even though it is not OpenAI-shaped: it is a key-pooled direct
 * provider whose SDK takes a base URL, so a deployment may repoint it. What it must NOT do is
 * reach the container proxy's forward path, which is why {@link resolveOpenAiCompatibleUpstream}
 * narrows first rather than treating "a base URL resolved" as the membership test.
 */
export function baseUrlFor(provider: string, env: Env): string | null {
  const read = isDirectProvider(provider) ? BASE_URL_OVERRIDE[provider] : undefined
  return resolveOpenAiCompatibleBaseUrl(provider, read?.(env)) ?? null
}

/** A resolved OpenAI-compatible upstream: where to send the request (key-free). */
export interface UpstreamEndpoint {
  baseURL: string
}

/**
 * Resolve a provider id to its OpenAI-compatible upstream base URL. Returns null for providers
 * that are not OpenAI-compatible (`workers-ai`, which runs in-process through the `AI` binding
 * here, and `anthropic`, whose own dialect would be sent a body it does not accept). The API key is
 * leased per call from the DB-backed pool by the proxy: it is not read from env here.
 *
 * The membership test is the shared table's own predicate, NOT "did a base URL resolve": the two
 * differ for `anthropic`, which resolves one and must still be refused. Symmetric with the Node
 * facade's `HttpLlmUpstream`, whose header carries the same rule.
 */
export function resolveOpenAiCompatibleUpstream(
  provider: string,
  env: Env,
): UpstreamEndpoint | null {
  if (!isOpenAiCompatibleProvider(provider)) return null
  const baseURL = baseUrlFor(provider, env)
  if (!baseURL) return null
  return { baseURL }
}
