import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { LanguageModel } from 'ai'
import { MODEL_SUPPORT_DOCS } from './docs.js'
import { UI_CONFIGURABLE_DIRECT_PROVIDERS } from './endpoints.js'

// The generic AI provisioning facade. The domain references a model only by a
// provider-agnostic {@link ModelRef}; a `ModelResolver` turns that into a concrete
// Vercel AI SDK model. A `ProviderRegistry` is a named set of resolvers (one per
// provider id) contributed by a package or a deployment, and `CompositeModelProvider`
// merges any number of registries into a single {@link ModelProvider}.
//
// This is what makes provisioning extensible: the base registry (OpenAI, Anthropic,
// the OpenAI-compatible vendors, Cloudflare-over-REST) lives here; heavier or optional
// backends ship as their own packages (e.g. `@cat-factory/provider-bedrock`) and an
// installation mixes them in — `new CompositeModelProvider(baseRegistry, bedrockRegistry(opts))`
// — without the core packages taking a dependency on every provider SDK.

/** Resolves one provider's {@link ModelRef} into a model the AI SDK can call. */
export type ModelResolver = (ref: ModelRef) => LanguageModel

/**
 * A set of resolvers keyed by provider id (`openai`, `anthropic`, `bedrock`, …).
 * An entry may be `undefined` so callers can register conditionally (e.g. only when
 * a credential is configured) without filtering first.
 */
export type ProviderRegistry = Record<string, ModelResolver | undefined>

/**
 * A {@link ModelProvider} composed from one or more {@link ProviderRegistry registries}.
 * `resolve` dispatches on `ref.provider` and throws a clear error for any provider that
 * was not registered. Later registrations win for the same provider id, so a deployment
 * can override a base resolver by mixing in its own registry afterwards.
 */
export class CompositeModelProvider implements ModelProvider {
  private readonly resolvers = new Map<string, ModelResolver>()

  constructor(...registries: ProviderRegistry[]) {
    for (const registry of registries) this.register(registry)
  }

  /** Mix in a registry; returns `this` for fluent chaining. */
  register(registry: ProviderRegistry): this {
    for (const [provider, resolver] of Object.entries(registry)) {
      if (resolver) this.resolvers.set(provider, resolver)
    }
    return this
  }

  /** Provider ids currently registered (useful for diagnostics / a /models gate). */
  providers(): string[] {
    return [...this.resolvers.keys()]
  }

  resolve(ref: ModelRef): LanguageModel {
    const resolver = this.resolvers.get(ref.provider)
    if (!resolver) throw new Error(unsupportedModelProviderMessage(ref.provider, this.providers()))
    return resolver(ref)
  }
}

/**
 * The remedy for a model ref whose provider has no resolver registered. A provider is registered
 * only when its credentials are configured, so an unregistered provider almost always means "this
 * deployment has no key/config for it" — not a bug. The message follows the initiative's UI-first
 * rule: for the UI-configurable direct providers it names the workspace API-key pool as the primary
 * fix, and only mentions the deployment-level env vars as the alternative; it also lists what IS
 * registered as a diagnostic, and links the model-support doc.
 */
export function unsupportedModelProviderMessage(provider: string, registered: string[]): string {
  const have = registered.length ? registered.slice().sort().join(', ') : 'none'
  const uiConfigurable = UI_CONFIGURABLE_DIRECT_PROVIDERS.join(', ')
  return (
    `Unsupported model provider '${provider}': no resolver is registered for it, so this ` +
    `deployment has no credentials configured for it. ` +
    `Fix: if it is a UI-configurable provider (${uiConfigurable}), add an API key for it to ` +
    `the workspace AI provider key pool ` +
    `(Settings → AI providers). Otherwise configure it at the deployment level — e.g. ` +
    `CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN for Cloudflare Workers AI (Node), or ` +
    `BEDROCK_REGION for AWS Bedrock. Currently registered providers: ${have}. ` +
    `See ${MODEL_SUPPORT_DOCS.provisioning()}`
  )
}
