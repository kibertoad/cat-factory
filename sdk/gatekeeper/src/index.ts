// The hand-written half of `@cat-factory/gatekeeper-bindings`: the scope-ladder helpers a
// credential-holding front-end ranks keys and bindings with. The table itself is generated
// (`bindings.generated.ts`); this module adds only what the spec cannot state.

import {
  GATEKEEPER_BINDINGS,
  PUBLIC_API_SCOPE_LADDER,
  type GatekeeperBinding,
  type PublicApiScope,
} from './bindings.generated.js'

export {
  GATEKEEPER_BINDINGS,
  PUBLIC_API_SCOPE_LADDER,
  type GatekeeperBinding,
  type PublicApiScope,
} from './bindings.generated.js'

/**
 * Whether a key of scope `have` satisfies a floor of `need`. The ladder is inclusive: every rung
 * can do everything below it, so this is a rank comparison over `PUBLIC_API_SCOPE_LADDER`, whose
 * array order IS the ranking (the same derivation the server's own check uses).
 */
export function scopeSatisfies(have: PublicApiScope, need: PublicApiScope): boolean {
  return PUBLIC_API_SCOPE_LADDER.indexOf(have) >= PUBLIC_API_SCOPE_LADDER.indexOf(need)
}

/**
 * The bindings a key of the given scope can call: what a Gatekeeper may expose to a caller it
 * backs with that key. The floor is the deployment's own admission rule, so filtering here keeps
 * a front-end from listing a capability its key would only ever see refused. Remember it is the
 * STATIC floor: a run-starting binding can still be refused at request time when the named
 * pipeline can park on a human (`pipeline_requires_decide_scope`).
 */
export function bindingsWithinScope(scope: PublicApiScope): GatekeeperBinding[] {
  return GATEKEEPER_BINDINGS.filter((binding) => scopeSatisfies(scope, binding.minScope))
}

const byName = new Map(GATEKEEPER_BINDINGS.map((binding) => [binding.name, binding]))

/**
 * Look a binding up by its policy name (`tasks_create`). Returns `undefined` for a name the
 * surface does not have, so a policy file naming a retired or misspelled operation is a condition
 * the caller reports rather than a thrown surprise.
 */
export function bindingByName(name: string): GatekeeperBinding | undefined {
  return byName.get(name)
}
