import type { OptionalCoreModules } from '../container.js'

/** The keys of every optional module a {@link ModuleRegistry} can assemble. */
export type OptionalModuleKey = keyof OptionalCoreModules

/**
 * A tiny, typed assembly registry for the domain composition root's OPTIONAL modules —
 * the ~40 features (GitHub, documents, tasks, environments, requirements, notifications,
 * sandbox, …) that are wired only when their prerequisites are configured.
 *
 * It replaces two footguns that grew with every added module in `createCore`:
 *   1. the ~40 `const x = createX(...)` locals scattered through one 500-line function, and
 *   2. the ~40 hand-written `...(x ? { x } : {})` conditional spreads in the return object.
 *
 * Instead each module is DECLARED once through {@link build} (key + factory), instantiated
 * ONLY when its factory yields a value (prerequisites configured), and read back by other
 * modules through {@link get}. The whole set is emitted in ONE place via {@link assemble} —
 * so adding a module is a single `build(...)` call plus its `OptionalCoreModules` field, not
 * a four-site edit. Registration order IS dependency order (a module reads only modules built
 * before it via {@link get}), so ordering is explicit and local rather than positional across
 * a giant function.
 *
 * The registry is deliberately a plain sequential builder, NOT a topological resolver: the
 * composition root has genuine circular late-bindings in its core spine (account ⇄ spend,
 * engine ⇄ initiative loop) that a declarative graph can't express cleanly, so the spine
 * stays explicit and only the acyclic optional modules flow through here.
 */
export class ModuleRegistry {
  private readonly built: Partial<OptionalCoreModules> = {}

  /**
   * Declare an optional module: run its `factory`, store the result under `key` when it is
   * defined (its prerequisites were configured), and return it so a heavily-consumed module
   * can also be kept in a local. A factory returning `undefined` is a clean no-op — the key is
   * simply absent from the assembled set, exactly like the old conditional spread.
   */
  build<K extends OptionalModuleKey>(
    key: K,
    factory: () => OptionalCoreModules[K] | undefined,
  ): OptionalCoreModules[K] | undefined {
    const value = factory()
    if (value !== undefined) this.built[key] = value
    return value
  }

  /** Read a previously-built optional module (undefined when unwired), for inter-module wiring. */
  get<K extends OptionalModuleKey>(key: K): OptionalCoreModules[K] | undefined {
    return this.built[key]
  }

  /**
   * The assembled optional modules, with unwired keys absent — spread into the `Core` return
   * alongside the always-present spine. This is the SINGLE site the optional set is emitted from.
   */
  assemble(): OptionalCoreModules {
    return this.built
  }
}
