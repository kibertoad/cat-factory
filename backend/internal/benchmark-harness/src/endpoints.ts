import {
  cloudflareRestBaseUrl,
  isOpenAiCompatibleProvider,
  resolveOpenAiCompatibleBaseUrl,
} from '@cat-factory/agents'
import type { ModelRef } from '@cat-factory/kernel'
import type { PiEndpoint } from './types'

// Where to point Pi for the implementation task. Pi only speaks the OpenAI
// `/chat/completions` shape, so each provider resolves to an OpenAI-compatible
// base URL + the env var holding its bearer key.
//
// Both halves are DERIVED, never restated here. The base URL comes from the shared provider table
// in @cat-factory/agents (`OPENAI_COMPATIBLE_ENDPOINTS`), which is the one place a vendor's endpoint
// is named: a local copy meant the harness kept dialling a stale host after a regional endpoint
// moved, and left `xai`, `openrouter` and the two operator-hosted gateways unreachable from
// benchmarks for no reason other than an unmaintained list. The key var is the platform's own
// `${PROVIDER}_API_KEY` convention, so it needs no table at all.
//
// Cloudflare Workers AI exposes an OpenAI-compatible surface too, so it is reachable locally: the
// "local + Cloudflare AI" path for the Pi-driven task as well. It is NOT a member of that table
// (its URL is a function of the account, not a constant), so it resolves through the shared
// `cloudflareRestBaseUrl` and reads the harness's own `CF_*` pair.

/** Cloudflare Workers AI's OpenAI-compatible base URL for an account. */
export function cloudflareAiBaseUrl(accountId: string): string {
  return cloudflareRestBaseUrl({ accountId })
}

/**
 * Resolve the Pi endpoint for a model. An explicit endpoint on the candidate
 * wins; otherwise it is derived from the provider (with Workers AI mapped to the
 * Cloudflare REST OpenAI-compatible endpoint, keyed by CF_API_TOKEN).
 *
 * A provider that cannot be reached fails with the reason, not one message for two causes: a
 * provider Pi cannot speak to at all is a different fix from an operator-hosted gateway whose
 * `${PROVIDER}_BASE_URL` this shell has not exported.
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
  const upper = ref.provider.toUpperCase()
  if (!isOpenAiCompatibleProvider(ref.provider)) {
    throw new Error(
      `Provider '${ref.provider}' is not reached over an OpenAI-compatible endpoint, so Pi ` +
        `cannot drive it; supply an explicit endpoint in the model candidate`,
    )
  }
  const baseUrl = resolveOpenAiCompatibleBaseUrl(ref.provider, env[`${upper}_BASE_URL`])
  if (!baseUrl) {
    // Only reachable for an operator-hosted gateway: every other member of the table carries a
    // built-in default, so an absence here IS an unset override.
    throw new Error(
      `'${ref.provider}' is an operator-hosted gateway with no public endpoint; set ` +
        `${upper}_BASE_URL to your own instance`,
    )
  }
  return { baseUrl, keyEnv: `${upper}_API_KEY` }
}
