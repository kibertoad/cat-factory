// ---------------------------------------------------------------------------
// A typed, app-owned registry of wired "providers" — the deployment-supplied data sources a
// gate (or any extension) probes. It replaces the per-provider module-global `let provider;
// wireFoo(); getFoo()` trio that every gate package used to hand-author, and the unsafe
// `getFoo()!` non-null assertion that followed a `wired()` check.
//
// A provider is identified by a {@link ProviderToken} — an opaque, phantom-typed handle the
// registrant defines once and exports. The deployment wires an impl against the token at
// startup on the registry INSTANCE the facade owns ({@link ProviderRegistry.wire}); the gate
// reads it back through its {@link GateContext} (`ctx.getProvider` / `ctx.requireProvider` /
// `ctx.isProviderWired`), so it no longer closes over a module global.
//
// `require` throws when the token is unwired — which is SAFE inside a gate's `probe()` because
// the engine only ever probes a gate whose `wired()` returned true, and a gate's `wired()` is
// `ctx.isProviderWired(token)`. So the "checked wired, then asserted with `!`" race the old
// pattern had is gone: the same token drives both.
//
// This lives in kernel (alongside the gate registry) so both the kernel `GateContext` and the
// `@cat-factory/gates` package can reference it. The composition root news ONE instance
// (`defaultProviderRegistry()`), threads it through `CoreDependencies`, and each facade wires
// its configured providers on that instance — so, unlike the former module global, a fresh
// instance per container build starts empty (no leak of a previous build's wiring) and a
// separately-published extension package can never register into a phantom `Map`.
// ---------------------------------------------------------------------------

/**
 * A typed handle for a wired provider. The phantom `T` carries the provider's interface so
 * `wire`/`get`/`require` are type-checked against the token. Create one with
 * {@link defineProviderToken} and export it next to the provider interface.
 */
export interface ProviderToken<T> {
  /** Unique identity for the registry map (one per `defineProviderToken` call). */
  readonly key: symbol
  /** Human description, used in error messages and validation output. */
  readonly description: string
  /** Phantom field carrying `T` — never read at runtime. */
  readonly __type?: T
}

/**
 * Define a new provider token. Call once at module scope and export the result, e.g.
 * `export const LICENSE_PROVIDER = defineProviderToken<LicenseProvider>('license')`.
 */
export function defineProviderToken<T>(description: string): ProviderToken<T> {
  return { key: Symbol(description), description }
}

/**
 * App-owned registry of wired providers, keyed by a {@link ProviderToken}'s symbol. Mirrors the
 * gate / agent-kind registries: the composition root news ONE instance, threads it through
 * `CoreDependencies` into the gate machine's {@link GateContext}, and each facade wires its
 * configured providers here at build time. There is no module-global `Map` and no `clear*()`
 * cruft — a fresh instance per build starts empty.
 */
export class ProviderRegistry {
  private readonly providers = new Map<symbol, unknown>()

  /** Wire (or clear, with `undefined`) the impl for a token. */
  wire<T>(token: ProviderToken<T>, impl: T | undefined): void {
    if (impl === undefined) this.providers.delete(token.key)
    else this.providers.set(token.key, impl)
  }

  /** The wired impl for a token, or `undefined` when nothing is wired. */
  get<T>(token: ProviderToken<T>): T | undefined {
    return this.providers.get(token.key) as T | undefined
  }

  /** Whether an impl is wired for a token (the canonical source for a gate's `wired()`). */
  isWired<T>(token: ProviderToken<T>): boolean {
    return this.providers.has(token.key)
  }

  /**
   * The wired impl for a token, or throw when nothing is wired. SAFE inside a gate's `probe()` —
   * the engine only probes a gate whose `wired()` (i.e. {@link isWired}) returned true — so it
   * replaces the old `getFoo()!` assertion with a real guard.
   */
  require<T>(token: ProviderToken<T>): T {
    const impl = this.providers.get(token.key)
    if (impl === undefined) {
      throw new Error(`Provider "${token.description}" is not wired.`)
    }
    return impl as T
  }
}

/** A fresh, empty provider registry. Each facade news one and wires its configured providers on it. */
export function defaultProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry()
}
