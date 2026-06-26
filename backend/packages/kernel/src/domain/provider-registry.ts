// ---------------------------------------------------------------------------
// A typed, process-wide registry of wired "providers" — the deployment-supplied data
// sources a gate (or any extension) probes. It replaces the per-provider module-global
// `let provider; wireFoo(); getFoo()` trio that every gate package used to hand-author,
// and the unsafe `getFoo()!` non-null assertion that followed a `wired()` check.
//
// A provider is identified by a {@link ProviderToken} — an opaque, phantom-typed handle
// the registrant defines once and exports. The deployment wires an impl against the token
// at startup ({@link wireProvider}); the gate reads it back through its {@link GateContext}
// (`ctx.getProvider` / `ctx.requireProvider`), so it no longer closes over a module global.
//
// `requireProvider` throws when the token is unwired — which is SAFE inside a gate's
// `probe()` because the engine only ever probes a gate whose `wired()` returned true, and
// a gate's `wired()` is `isProviderWired(token)`. So the "checked wired, then asserted with
// `!`" race the old pattern had is gone: the same token drives both.
//
// This lives in kernel (alongside the gate / pipeline registries) so both the kernel
// `GateContext` and the `@cat-factory/gates` package can reference it, and so a deployment
// package can wire a provider as a startup import side effect without depending on the heavy
// orchestration package.
// ---------------------------------------------------------------------------

/**
 * A typed handle for a wired provider. The phantom `T` carries the provider's interface so
 * `wireProvider`/`getProvider`/`requireProvider` are type-checked against the token. Create
 * one with {@link defineProviderToken} and export it next to the provider interface.
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

// Process-wide map, keyed by the token's symbol. Mirrors the gate / agent-kind / pipeline
// registry model: wiring is a startup side effect, read at gate-probe time.
const providers = new Map<symbol, unknown>()

/** Wire (or clear, with `undefined`) the impl for a token. */
export function wireProvider<T>(token: ProviderToken<T>, impl: T | undefined): void {
  if (impl === undefined) providers.delete(token.key)
  else providers.set(token.key, impl)
}

/** The wired impl for a token, or `undefined` when nothing is wired. */
export function getProvider<T>(token: ProviderToken<T>): T | undefined {
  return providers.get(token.key) as T | undefined
}

/** Whether an impl is wired for a token (the canonical source for a gate's `wired()`). */
export function isProviderWired<T>(token: ProviderToken<T>): boolean {
  return providers.has(token.key)
}

/**
 * The wired impl for a token, or throw when nothing is wired. SAFE inside a gate's
 * `probe()` — the engine only probes a gate whose `wired()` (i.e. {@link isProviderWired})
 * returned true — so it replaces the old `getFoo()!` assertion with a real guard.
 */
export function requireProvider<T>(token: ProviderToken<T>): T {
  const impl = providers.get(token.key)
  if (impl === undefined) {
    throw new Error(`Provider "${token.description}" is not wired.`)
  }
  return impl as T
}

/** Clear EVERY wired provider. Intended for tests that exercise wiring in isolation. */
export function clearProviders(): void {
  providers.clear()
}
