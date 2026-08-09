// The hand-written half of `@cat-factory/gatekeeper-bindings`: the scope-ladder helpers a
// credential-holding front-end ranks keys and bindings with. The table itself is generated
// (`bindings.generated.ts`); this module adds only what the spec cannot state.

import {
  GATEKEEPER_BINDINGS,
  PUBLIC_API_SCOPE_LADDER,
  type GatekeeperBinding,
  type PublicApiScope,
} from './bindings.generated.js'

import { SESSION_METHOD_SIGNATURES } from './session-types.generated.js'

export {
  GATEKEEPER_BINDINGS,
  PUBLIC_API_SCOPE_LADDER,
  TELEMETRY_BINDINGS,
  type GatekeeperBinding,
  type GatekeeperQueryParam,
  type PublicApiScope,
  type TelemetrySink,
} from './bindings.generated.js'

export {
  SESSION_METHOD_SIGNATURES,
  type SessionMethodSignature,
} from './session-types.generated.js'

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

const signatureByName = new Map(
  SESSION_METHOD_SIGNATURES.map((signature) => [signature.name, signature]),
)

/** What {@link renderSessionTypes} needs beyond the binding names. */
export interface SessionTypesRequest {
  /** The interface name the rendered file exports, and the one a resource declares as its `tsType`. */
  interfaceName: string
  /** The binding names the session actually carries, in the order they should be declared. */
  bindings: readonly string[]
  /**
   * Declarations for members the session carries that are NOT bindings, each already indented and
   * newline-terminated. A capability's reserved methods live one layer up, in whatever consumes
   * this table, so they arrive as source rather than as a second list here that could disagree.
   */
  extraMembers?: readonly string[]
  /** Prose spliced into the file's own header, saying whose session this describes. */
  preamble?: string
}

/**
 * Render the `.d.ts` an object-capability session serves as its TypeScript types.
 *
 * A session carries exactly what its policy granted, so the declaration a caller reads is composed
 * per session rather than shipped whole: a file naming the full surface would promise methods the
 * object does not have. Composition is the only step, and it is total: a name with no generated
 * signature THROWS rather than being skipped, because a silently dropped method reads to an agent
 * exactly like an operation this deployment does not serve, and the two need opposite fixes.
 */
export function renderSessionTypes(request: SessionTypesRequest): string {
  const members = request.bindings.map((name) => {
    const signature = signatureByName.get(name)
    if (signature === undefined) {
      throw new TypeError(
        `No session signature for binding '${name}'. The table this renders from is generated ` +
          'from the same spec the bindings are, so a name reaching here that it does not carry ' +
          'means the two are out of step: upgrade @cat-factory/gatekeeper-bindings.',
      )
    }
    return `${signature.doc}${signature.signature}`
  })

  const header =
    '// Generated by the cat-factory Gatekeeper from its own operation table. Do not edit.\n' +
    '//\n' +
    (request.preamble ? `${request.preamble}\n//\n` : '') +
    "// Every method returns the deployment's decoded JSON, typed as `unknown`: the authority for\n" +
    '// those shapes is the OpenAPI document at `GET /api/v1/openapi.json` on the paired\n' +
    '// deployment, and a second copy inlined here would be free to disagree with it.\n'

  return (
    `${header}\nexport interface ${request.interfaceName} {\n` +
    [...(request.extraMembers ?? []), ...members].join('\n') +
    '}\n'
  )
}
