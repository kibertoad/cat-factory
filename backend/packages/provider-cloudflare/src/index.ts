import {
  type ModelResolver,
  type ProviderRegistry,
  cloudflareRestResolver,
} from '@cat-factory/agents'
import { createWorkersAI } from 'workers-ai-provider'

// Opt-in Cloudflare Workers AI support for the AI provisioning facade. This lives in
// its own package (like @cat-factory/provider-bedrock) so Workers AI is NOT assumed
// available anywhere: a deployment must explicitly mix it into its CompositeModelProvider.
// It contributes the `workers-ai` provider in one of two flavours:
//
//   - binding: the in-process Cloudflare `AI` binding (Worker only)
//       new CompositeModelProvider(base, cloudflareBindingRegistry({ binding: env.AI }))
//   - REST:    the OpenAI-compatible REST endpoint / AI Gateway (Node, local, …)
//       new CompositeModelProvider(base, cloudflareRestRegistry({ accountId, apiToken }))

/** The Cloudflare `AI` binding shape (the parameter `createWorkersAI` expects). */
export type WorkersAiBinding = Parameters<typeof createWorkersAI>[0]['binding']

/** A {@link ModelResolver} for `workers-ai` over the in-process Cloudflare `AI` binding. */
export function cloudflareBindingResolver(binding: WorkersAiBinding): ModelResolver {
  // workers-ai-provider@3 implements the same provider spec as `ai` v6
  // (`@ai-sdk/provider` v3), so the model is a real LanguageModel — no cast.
  const workersai = createWorkersAI({ binding })
  return (ref) => workersai(ref.model as Parameters<typeof workersai>[0])
}

/** A {@link ProviderRegistry} contributing `workers-ai` via the in-process binding. */
export function cloudflareBindingRegistry(opts: { binding: WorkersAiBinding }): ProviderRegistry {
  return { 'workers-ai': cloudflareBindingResolver(opts.binding) }
}

/**
 * A {@link ProviderRegistry} contributing `workers-ai` over the OpenAI-compatible REST
 * endpoint (account id + API token) or an AI Gateway. This is how non-Worker deployments
 * (Node, local) serve Cloudflare models — same provider id as the binding flavour, so a
 * model pinned `workers-ai` resolves on every deployment that opts in.
 */
export function cloudflareRestRegistry(opts: {
  accountId: string
  apiToken: string
  /** AI Gateway slug; when set, routes through the gateway instead of the direct REST API. */
  gateway?: string
  /** Full override of the base URL (wins over accountId/gateway). */
  baseURL?: string
}): ProviderRegistry {
  return { 'workers-ai': cloudflareRestResolver(opts) }
}
