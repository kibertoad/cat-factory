import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock'
import type { ModelResolver, ProviderRegistry } from '@cat-factory/agents'

// Opt-in AWS Bedrock support for the AI provisioning facade. This lives in its own
// package so the AWS Bedrock SDK is pulled in only by deployments that actually use it;
// the core packages and the Cloudflare Worker stay free of it. Mix it into a
// CompositeModelProvider:
//
//   new CompositeModelProvider(baseRegistry, bedrockRegistry({ region, supportedModels }))

export interface BedrockResolverOptions {
  /** AWS region, e.g. `us-east-1`. */
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** Override the Bedrock base URL (e.g. a VPC endpoint). */
  baseURL?: string
  /**
   * Allow-list of Bedrock model ids this deployment may use. When set, resolving any
   * model outside it throws — so an unsupported model fails fast with a clear message
   * rather than a deep AWS error. When omitted, any model id is forwarded to Bedrock.
   */
  supportedModels?: readonly string[]
}

/** A {@link ModelResolver} for the `bedrock` provider. */
export function bedrockResolver(opts: BedrockResolverOptions = {}): ModelResolver {
  const provider = createAmazonBedrock({
    ...(opts.region ? { region: opts.region } : {}),
    ...(opts.accessKeyId ? { accessKeyId: opts.accessKeyId } : {}),
    ...(opts.secretAccessKey ? { secretAccessKey: opts.secretAccessKey } : {}),
    ...(opts.sessionToken ? { sessionToken: opts.sessionToken } : {}),
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  })
  const allow = opts.supportedModels ? new Set(opts.supportedModels) : null
  return (ref) => {
    if (allow && !allow.has(ref.model)) {
      throw new Error(`Unsupported Bedrock model: ${ref.model}`)
    }
    return provider(ref.model)
  }
}

/** A {@link ProviderRegistry} contributing the `bedrock` provider, ready to mix in. */
export function bedrockRegistry(opts: BedrockResolverOptions = {}): ProviderRegistry {
  return { bedrock: bedrockResolver(opts) }
}
