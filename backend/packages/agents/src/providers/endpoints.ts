import { isLocalRunner } from '@cat-factory/contracts'

// The OpenAI-compatible chat endpoints behind the direct-provider flavours.
// DashScope (Alibaba/Qwen), DeepSeek and Moonshot (Kimi) all expose the OpenAI
// `/chat/completions` shape, so both the Vercel-AI model provider and the container
// LLM proxy resolve them from the same base URLs and keys — one source of truth for
// "where does provider X live". Each is overridable per deployment (a self-hosted
// gateway, a regional endpoint, or a local stub in tests).
export const QWEN_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
export const MOONSHOT_BASE_URL = 'https://api.moonshot.ai/v1'
export const OPENAI_BASE_URL = 'https://api.openai.com/v1'
// OpenRouter is a single OpenAI-compatible gateway to 300+ models. LiteLLM has NO
// built-in default: it is an operator-hosted gateway, so its base URL comes from the
// deployment's LITELLM_BASE_URL override (there is no public endpoint to default to).
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Built-in base URLs for the OpenAI-compatible providers, keyed by provider id. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URLS: Readonly<Record<string, string>> = {
  qwen: QWEN_BASE_URL,
  deepseek: DEEPSEEK_BASE_URL,
  moonshot: MOONSHOT_BASE_URL,
  openai: OPENAI_BASE_URL,
  openrouter: OPENROUTER_BASE_URL,
}

/**
 * Providers the container LLM proxy can serve, so a container agent's locked model
 * must resolve to one of them (see `LlmProxyController`):
 *  - `workers-ai` — run in-Worker through the AI binding (no upstream, no key);
 *  - every direct OpenAI-compatible upstream the proxy forwards to: the built-in
 *    {@link DEFAULT_OPENAI_COMPATIBLE_BASE_URLS} entries (qwen / deepseek / moonshot /
 *    openai / **openrouter**) plus the operator-hosted **litellm** gateway, which has
 *    no public default and resolves only once `LITELLM_BASE_URL` is set;
 *  - the per-user local runners (Ollama / LM Studio / …), forwarded to the run
 *    initiator's own endpoint with no key lease.
 *
 * NOT the pooled-subscription harnesses (Claude Code / Codex), which talk to the
 * vendor directly with a leased token and so never go through the proxy.
 */
export function isProxyableProvider(provider: string): boolean {
  return (
    provider === 'workers-ai' ||
    provider === 'litellm' ||
    Object.hasOwn(DEFAULT_OPENAI_COMPATIBLE_BASE_URLS, provider) ||
    isLocalRunner(provider)
  )
}
