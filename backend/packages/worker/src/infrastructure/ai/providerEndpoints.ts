import type { Env } from '../env'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours.
// DashScope (Alibaba/Qwen), DeepSeek and Moonshot (Kimi) all expose the OpenAI
// `/chat/completions` shape, so both the Vercel-AI model provider
// (CloudflareModelProvider) and the container LLM proxy (LlmProxyController)
// resolve them from the same base URLs and keys here — one source of truth for
// "where does provider X live and which env var holds its key".
//
// Each base URL is overridable via env (e.g. QWEN_BASE_URL) so a deployment can
// point a provider at a self-hosted gateway, a regional endpoint, or — in the
// acceptance tests — a local stub, without code changes.
export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

/** The effective base URL for a provider: env override, else the built-in default. */
export function baseUrlFor(provider: string, env: Env): string | null {
  switch (provider) {
    case 'qwen':
      return env.QWEN_BASE_URL ?? QWEN_BASE_URL
    case 'deepseek':
      return env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL
    case 'moonshot':
      return env.MOONSHOT_BASE_URL ?? MOONSHOT_BASE_URL
    case 'openai':
      return env.OPENAI_BASE_URL ?? OPENAI_BASE_URL
    default:
      return null
  }
}

/** A resolved OpenAI-compatible upstream: where to send the request and the key. */
export interface UpstreamEndpoint {
  baseURL: string
  apiKey: string
}

/**
 * Resolve a provider id to its OpenAI-compatible upstream (base URL + key from
 * `env`). Returns null for providers that are not OpenAI-compatible (e.g.
 * `workers-ai`, `anthropic`) or whose key is not configured — the proxy then
 * rejects the request rather than forwarding it without credentials.
 */
export function resolveOpenAiCompatibleUpstream(
  provider: string,
  env: Env,
): UpstreamEndpoint | null {
  const baseURL = baseUrlFor(provider, env)
  if (!baseURL) return null
  const apiKey =
    provider === 'qwen'
      ? env.QWEN_API_KEY
      : provider === 'deepseek'
        ? env.DEEPSEEK_API_KEY
        : provider === 'moonshot'
          ? env.MOONSHOT_API_KEY
          : provider === 'openai'
            ? env.OPENAI_API_KEY
            : undefined
  return apiKey ? { baseURL, apiKey } : null
}
