import {
  cloudflareRestBaseUrl,
  openRouterRoutingFrom,
  resolveOpenAiCompatibleBaseUrl,
  type OpenRouterRouting,
} from '@cat-factory/agents'

// The Node facade's env plumbing for the shared provider table, and NOTHING else: this module is
// deliberately a LEAF over @cat-factory/agents.
//
// It was carved out of `modelProvider.ts`, which also builds the Bedrock/Cloudflare registries and
// the Langfuse/OTel sinks. Importing a one-line env read from there pulled the OpenTelemetry Node
// SDK and both provider registries into the container-proxy gateway's module graph (and into a
// spec whose own header says it needs no database), for a `${PROVIDER}_BASE_URL` lookup.
//
// The mirror on the other facade is `runtimes/cloudflare/src/infrastructure/ai/providerEndpoints.ts`.
// The difference between them is the whole reason each facade owns this file: `env` there is a
// typed interface, so it needs a total per-provider accessor map, while here it is a string-keyed
// bag that can be read by name.

/**
 * The base URL for a direct provider: the `${PROVIDER}_BASE_URL` env override (e.g.
 * QWEN_BASE_URL), else the built-in default. The override-vs-default precedence and the
 * defaults table itself live in @cat-factory/agents so the Worker resolves identically; the
 * operator-hosted gateways (`bifrost`, `litellm`) have no default and so resolve only once their
 * own `BIFROST_BASE_URL` / `LITELLM_BASE_URL` is set.
 *
 * Env is read by NAME rather than from a per-provider table, so this is also what the container
 * LLM proxy's Node upstream resolves through (`gateways.ts`): the one resolution both the inline
 * and container paths take.
 */
export function baseUrlForNode(provider: string, env: NodeJS.ProcessEnv): string | undefined {
  return resolveOpenAiCompatibleBaseUrl(provider, env[`${provider.toUpperCase()}_BASE_URL`])
}

/**
 * This deployment's OpenRouter routing constraints: what it will let the gateway route to.
 * Strict on both axes unless the operator says otherwise; the parse and its reasoning are shared
 * with the Worker facade so one deployment cannot be permissive on one runtime and strict on the
 * other.
 */
export function openRouterRoutingForNode(env: NodeJS.ProcessEnv): OpenRouterRouting {
  return openRouterRoutingFrom(env)
}

/** A deployment's Cloudflare account credentials for reaching Workers AI over REST. */
export interface CloudflareRestCredentials {
  accountId: string
  apiToken: string
  gateway?: string
}

/**
 * The deployment's Cloudflare REST credentials, or undefined when Workers AI is not configured
 * here. BOTH halves are required: an account id with no token cannot authenticate, and the boot
 * path names the missing half (`cloudflareCredsHalfSet`) rather than leaving the provider silently
 * off.
 *
 * The ONE reading of "does this deployment serve Cloudflare models", because four sites conclude
 * from it and they must conclude the SAME thing: the boot warning, the model catalog's
 * `cloudflareModelsEnabled` gate (what the picker offers), the inline resolver's registry, and the
 * container proxy's REST upstream. They used to read the pair separately, two of them without
 * trimming, so a whitespace-only `CLOUDFLARE_ACCOUNT_ID` offered models in the picker that neither
 * dispatch path could resolve.
 */
export function cloudflareRestCredentials(
  env: NodeJS.ProcessEnv,
): CloudflareRestCredentials | undefined {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim()
  if (!accountId || !apiToken) return undefined
  const gateway = env.CLOUDFLARE_AI_GATEWAY?.trim()
  return { accountId, apiToken, ...(gateway ? { gateway } : {}) }
}

/**
 * The `workers-ai` upstream for a runtime with no Cloudflare `AI` binding: Cloudflare's own
 * OpenAI-compatible REST endpoint (or the deployment's AI Gateway), carrying the account API
 * token as its bearer.
 *
 * The token rides the endpoint rather than being leased, because `workers-ai` is not an
 * `ApiKeyProvider`: there is no pool to lease from, and the credential is a deployment-level fact.
 * This is what keeps the dispatch guard honest on Node, where `isProxyableProvider` admits
 * `workers-ai` (it is runtime-neutral) and there is no binding to run it in-process.
 */
export function workersAiRestUpstream(
  env: NodeJS.ProcessEnv,
): { baseURL: string; apiKey: string } | undefined {
  const creds = cloudflareRestCredentials(env)
  if (!creds) return undefined
  return { baseURL: cloudflareRestBaseUrl(creds), apiKey: creds.apiToken }
}
