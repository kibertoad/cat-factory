import type { ModelProvider, ModelRef } from '@cat-factory/kernel'
import type { LanguageModel } from 'ai'

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
    if (!resolver) throw new Error(`Unsupported model provider: ${ref.provider}`)
    return resolver(ref)
  }
}
