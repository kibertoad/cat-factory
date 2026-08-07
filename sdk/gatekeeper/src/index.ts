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
 * Rank a rung on the ladder, REFUSING one the ladder does not carry.
 *
 * The refusal is the point. A rung this package has never heard of ranks -1 through a bare
 * `indexOf`, which compares as "below everything": `scopeSatisfies` then answers `false` and
 * `bindingsWithinScope` hands back an empty table, so a deployment one release ahead of this
 * package reads as a key with no permissions rather than as the version skew it is. A policy
 * layer typically takes its scope from configuration, where TypeScript is no help.
 */
function rankOf(scope: PublicApiScope): number {
  const rank = PUBLIC_API_SCOPE_LADDER.indexOf(scope)
  if (rank < 0) {
    throw new TypeError(
      `Unknown public-API scope '${scope}'. This package knows ` +
        `${PUBLIC_API_SCOPE_LADDER.join(' < ')}; upgrade @cat-factory/gatekeeper-bindings if the ` +
        'deployment has since added a rung.',
    )
  }
  return rank
}

/**
 * Whether a key of scope `have` satisfies a floor of `need`. The ladder is inclusive: every rung
 * can do everything below it, so this is a rank comparison over `PUBLIC_API_SCOPE_LADDER`, whose
 * array order IS the ranking (the same derivation the server's own check uses).
 *
 * Throws a `TypeError` on a scope that is not on the ladder; see {@link rankOf}.
 */
export function scopeSatisfies(have: PublicApiScope, need: PublicApiScope): boolean {
  return rankOf(have) >= rankOf(need)
}

/**
 * What calling a binding COSTS, with the cautious reading applied where the table states nothing.
 *
 * The generated `consequence` is present only where the stakes are real money or a merged pull
 * request, so most mutations carry no annotation at all: reading `binding.consequence?.destructive`
 * directly answers `false` for `tasks_update`, `tasks_stop` and every other unannotated write, and
 * a front-end filtering on it waves through exactly the calls it meant to hold back. That inverts
 * what the field documents, so the default lives here once rather than in each consumer.
 *
 * A GET is safe and idempotent by construction; anything else is assumed destructive and
 * non-idempotent until the table says otherwise.
 */
export function resolveConsequence(binding: GatekeeperBinding): {
  destructive: boolean
  idempotent: boolean
} {
  return {
    destructive: binding.consequence?.destructive ?? !binding.readOnly,
    idempotent: binding.consequence?.idempotent ?? binding.readOnly,
  }
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
