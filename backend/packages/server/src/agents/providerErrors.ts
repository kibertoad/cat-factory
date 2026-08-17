import { isOperatorHostedGateway, type OperatorHostedGateway } from '@cat-factory/agents'
import { DOCS, ENV_VARS_ANCHORS } from '../config/docs.js'

// Remedies for the OpenAI-compatible providers that resolve only once a base URL is configured.
// Two failure classes share this wording so the inline model provider and the container LLM proxy
// explain the same condition identically:
//   - a UI-pooled key exists but the provider has no resolvable base URL (the inline resolver), and
//   - a container agent's locked provider resolves to no upstream (the proxy).
// The operator-hosted gateways (Bifrost, LiteLLM) are called out specially: they are self-hosted
// software with NO public endpoint, so the base URL MUST come from their `${PROVIDER}_BASE_URL` —
// the generic wording buries the one thing an operator needs to know behind "the provider's
// OpenAI-compatible endpoint", which for a gateway they run themselves reads as nothing at all.

/**
 * How each operator-hosted gateway is spelled to a human. An exhaustive `Record` over the union
 * {@link OperatorHostedGateway}, which is itself DERIVED from the endpoint table, so adding an
 * endpoint-less gateway there fails to compile until its remedy can name it — rather than
 * degrading to the generic message that tells its operator nothing.
 */
const OPERATOR_HOSTED_GATEWAY_LABELS: Record<OperatorHostedGateway, string> = {
  bifrost: 'Bifrost',
  litellm: 'LiteLLM',
}

/**
 * The remedy for an OpenAI-compatible provider selected without a resolvable base URL. An
 * operator-hosted gateway gets a dedicated message naming its own `${PROVIDER}_BASE_URL` (there is
 * no public endpoint to default to); every other provider names that override and points at the
 * workspace key pool, since a pooled key for it is inert until the base URL is set.
 */
export function openAiCompatibleBaseUrlError(provider: string): string {
  const envVar = `${provider.toUpperCase()}_BASE_URL`
  if (isOperatorHostedGateway(provider)) {
    const label = OPERATOR_HOSTED_GATEWAY_LABELS[provider]
    return (
      `${label} is selected but its base URL is not configured. ${label} is an operator-hosted ` +
      `gateway with no public endpoint, so its base URL must be set explicitly. ` +
      `Fix: set ${envVar} to your ${label} gateway URL and restart — a ${label} key added ` +
      `to the workspace AI provider key pool stays unselectable until it is set. ` +
      `See ${DOCS.envVars(ENV_VARS_ANCHORS.modelProviders)}`
    )
  }
  return (
    `Provider '${provider}' uses an OpenAI-compatible API and needs a base URL, but none is ` +
    `configured. Fix: set ${envVar} to the provider's OpenAI-compatible endpoint and restart. ` +
    `If you added this provider's API key to the workspace AI provider key pool ` +
    `(Settings → AI providers), that key is inert until the base URL is set. ` +
    `See ${DOCS.modelSupport()}`
  )
}
