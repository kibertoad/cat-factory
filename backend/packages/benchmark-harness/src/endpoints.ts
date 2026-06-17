import type { ModelRef } from '@cat-factory/core'
import type { PiEndpoint } from './types'

// Where to point Pi for the implementation task. Pi only speaks the OpenAI
// `/chat/completions` shape, so each provider resolves to an OpenAI-compatible
// base URL + the env var holding its bearer key. Cloudflare Workers AI exposes
// an OpenAI-compatible surface too, so it is reachable locally — the
// "local + Cloudflare AI" path for the Pi-driven task as well.

const KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  qwen: 'QWEN_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
}

const BASE_URL: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.ai/v1',
}

/** Cloudflare Workers AI's OpenAI-compatible base URL for an account. */
export function cloudflareAiBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
}

/**
 * Resolve the Pi endpoint for a model. An explicit endpoint on the candidate
 * wins; otherwise it is derived from the provider (with Workers AI mapped to the
 * Cloudflare REST OpenAI-compatible endpoint, keyed by CF_API_TOKEN).
 */
export function resolvePiEndpoint(
  ref: ModelRef,
  explicit: PiEndpoint | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PiEndpoint {
  if (explicit) return explicit
  if (ref.provider === 'workers-ai') {
    const accountId = env.CF_ACCOUNT_ID
    if (!accountId) throw new Error('CF_ACCOUNT_ID is not set (needed for Workers AI via Pi)')
    return { baseUrl: cloudflareAiBaseUrl(accountId), keyEnv: 'CF_API_TOKEN' }
  }
  const baseUrl = BASE_URL[ref.provider]
  const keyEnv = KEY_ENV[ref.provider]
  if (!baseUrl || !keyEnv) {
    throw new Error(
      `No Pi endpoint known for provider '${ref.provider}'; supply an explicit endpoint in the model candidate`,
    )
  }
  return { baseUrl, keyEnv }
}
