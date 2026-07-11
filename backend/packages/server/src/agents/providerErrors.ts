import { DOCS, ENV_VARS_ANCHORS } from '../config/docs.js'

// Remedies for the OpenAI-compatible providers that resolve only once a base URL is configured.
// Two failure classes share this wording so the inline model provider and the container LLM proxy
// explain the same condition identically:
//   - a UI-pooled key exists but the provider has no resolvable base URL (the inline resolver), and
//   - a container agent's locked provider resolves to no upstream (the proxy).
// LiteLLM is called out specially: it is an operator-hosted gateway with NO public default, so its
// base URL MUST come from LITELLM_BASE_URL — the generic `${PROVIDER}_BASE_URL` wording would bury
// the one thing an operator needs to know.

/**
 * The remedy for an OpenAI-compatible provider selected without a resolvable base URL. `litellm`
 * gets a dedicated message naming `LITELLM_BASE_URL` (no public endpoint to default to); every other
 * provider names its `${PROVIDER}_BASE_URL` override and points at the workspace key pool, since a
 * pooled key for it is inert until the base URL is set.
 */
export function openAiCompatibleBaseUrlError(provider: string): string {
  if (provider === 'litellm') {
    return (
      `LiteLLM is selected but its base URL is not configured. LiteLLM is an operator-hosted ` +
      `gateway with no public endpoint, so its base URL must be set explicitly. ` +
      `Fix: set LITELLM_BASE_URL to your LiteLLM gateway URL and restart — a LiteLLM key added ` +
      `to the workspace AI provider key pool stays unselectable until it is set. ` +
      `See ${DOCS.envVars(ENV_VARS_ANCHORS.modelProviders)}`
    )
  }
  const envVar = `${provider.toUpperCase()}_BASE_URL`
  return (
    `Provider '${provider}' uses an OpenAI-compatible API and needs a base URL, but none is ` +
    `configured. Fix: set ${envVar} to the provider's OpenAI-compatible endpoint and restart. ` +
    `If you added this provider's API key to the workspace AI provider key pool ` +
    `(Settings → AI providers), that key is inert until the base URL is set. ` +
    `See ${DOCS.modelSupport()}`
  )
}
