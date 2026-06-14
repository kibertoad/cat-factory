import type { Env } from '../env'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours.
// DashScope (Alibaba/Qwen), DeepSeek and Moonshot (Kimi) all expose the OpenAI
// `/chat/completions` shape, so both the Vercel-AI model provider
// (CloudflareModelProvider) and the container LLM proxy (LlmProxyController)
// resolve them from the same base URLs and keys here — one source of truth for
// "where does provider X live and which env var holds its key".
export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'

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
  switch (provider) {
    case 'qwen':
      return env.QWEN_API_KEY ? { baseURL: QWEN_BASE_URL, apiKey: env.QWEN_API_KEY } : null
    case 'deepseek':
      return env.DEEPSEEK_API_KEY
        ? { baseURL: DEEPSEEK_BASE_URL, apiKey: env.DEEPSEEK_API_KEY }
        : null
    case 'moonshot':
      return env.MOONSHOT_API_KEY
        ? { baseURL: MOONSHOT_BASE_URL, apiKey: env.MOONSHOT_API_KEY }
        : null
    case 'openai':
      return env.OPENAI_API_KEY ? { baseURL: OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY } : null
    default:
      return null
  }
}
