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
 * ONLY when its factory yields a value (prerequisites configured). The whole set is emitted in
 * ONE place via {@link assemble} — so adding a module is a single `build(...)` call plus its
 * `OptionalCoreModules` field, not a four-site edit. Registration order IS dependency order:
 * `build` RETURNS the freshly-built value, so a module consumed downstream is kept in a local
 * and passed into the later factories that need it (exactly where the old
 * `const x = createX(...)` local sat). {@link get} additionally exposes any already-built module
 * by key for a reader that holds no local. Either way a factory only ever reaches modules built
 * before it, so ordering is explicit and local rather than positional across a giant function.
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
   * defined (its prerequisites were configured), and return it so a downstream factory can keep
   * it in a local and thread it in. A factory returning `undefined` is a clean no-op — the key is
   * simply absent from the assembled set, exactly like the old conditional spread.
   *
   * Presence is keyed on `!== undefined`, NOT truthiness: every module factory returns an object
   * or `undefined`, so this matches the removed `...(x ? { x } : {})` spread. A factory that
   * yielded a defined-but-falsy value (`null` / `0` / `''`) would be KEPT here where the old
   * spread dropped it — none does, so return `undefined` (never `null`) to mean "absent".
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
   *
   * Returning the `Partial<OptionalCoreModules>` backing store AS `OptionalCoreModules` is sound
   * ONLY because every field of `OptionalCoreModules` is optional, so the two types coincide.
   * Keep it that way: a NON-optional field would make this a lie — the return type would promise
   * a key the registry can legitimately omit. A new always-present service belongs on `CoreSpine`.
   */
  assemble(): OptionalCoreModules {
    return this.built
  }
}
