// Compiling a Gatekeeper policy: turning what an operator wrote into the exact set of methods a
// capability will carry, plus a STATED account of everything it will not.
//
// The whole point of the generated table (`@cat-factory/gatekeeper-bindings`) is that policy is
// enforced against the operations the deployment actually serves, at the scope floors it actually
// enforces, rather than against a hand-curated list that drifts. So compilation starts from
// `bindingsWithinScope(keyScope)` and only ever SUBTRACTS. A tier cannot grant its way above the
// key backing it, and an attempt to is an operator error raised here rather than a method that
// exists, looks granted, and 403s on every call.
//
// Nothing here decides transport, retry or auth: the SDK does, through each binding's own
// `invoke` thunk.

import {
  bindingByName,
  bindingsWithinScope,
  resolveConsequence,
  type GatekeeperBinding,
  type PublicApiScope,
} from '@cat-factory/gatekeeper-bindings'
import { PolicyError } from '../errors.js'

/**
 * What one tier of caller may do.
 *
 * `keyScope` is the scope of the cat-factory key the Gatekeeper mints for callers at this tier,
 * and it is also the ceiling on what the tier can be granted. The two being ONE value is what
 * keeps the credential and the capability from disagreeing.
 */
export interface TierPolicy {
  /** Prose an OS deployment shows beside the tier. */
  description: string
  /** The scope of the per-actor key this tier's calls are made with. */
  keyScope: PublicApiScope
  /** Binding names to grant, or `'*'` for every binding within `keyScope`. */
  allow: readonly string[] | '*'
  /** Binding names to subtract from `allow`. Applied last, so a deny always wins. */
  deny?: readonly string[]
  /**
   * Dotted paths masked out of every result before it reaches the caller, e.g.
   * `run.pullRequestUrl`. Masking is REDACTION, not omission: see `masking.ts`.
   */
  mask?: readonly string[]
}

/** The whole policy: the tiers, and which OS actor gets which. */
export interface GatekeeperPolicy {
  /** The tier an actor with no explicit grant is given. Name `null` to refuse unknown actors. */
  defaultTier: string | null
  tiers: Record<string, TierPolicy>
  /** OS user identity (whatever the OS authenticates) to tier name. */
  grants: Record<string, string>
}

/** Why a binding the deployment serves is not on a capability. */
export type WithheldReason =
  | 'not_in_policy'
  | 'denied_by_policy'
  | 'above_key_scope'
  | 'not_relayable'

/** One binding the tier does not carry, and why. */
export interface WithheldBinding {
  name: string
  reason: WithheldReason
  detail: string
}

/** A tier, resolved against the live operation table. */
export interface CompiledTier {
  name: string
  description: string
  keyScope: PublicApiScope
  granted: readonly GatekeeperBinding[]
  /**
   * Every binding this tier does NOT carry, with the reason. Published on the capability
   * (`withheld()`) because an agent that cannot tell "policy withheld this" from "the deployment
   * does not have it" will report the wrong one to whoever has to fix it.
   */
  withheld: readonly WithheldBinding[]
  mask: readonly string[]
}

/** The policy, resolved once and read per request. */
export interface CompiledPolicy {
  defaultTier: string | null
  tiers: ReadonlyMap<string, CompiledTier>
  grants: ReadonlyMap<string, string>
}

/**
 * `admin` is deliberately unreachable as a tier's `keyScope`.
 *
 * `POST /api/v1/keys` mints `read`, `write` or `decide` and never `admin`, so the platform already
 * holds the chain to one link: a key provisioned over the API can never itself provision. A tier
 * asking for `admin` is therefore asking for the Gatekeeper's OWN provisioning secret to be handed
 * to a caller, which is the one thing this whole design exists to prevent. Refusing it here names
 * that, rather than letting the mint fail per-actor at runtime with a platform error an operator
 * would read as a bug.
 */
const MINTABLE_SCOPES: readonly PublicApiScope[] = ['read', 'write', 'decide']

/**
 * A binding whose result is an SSE reader or raw bytes cannot cross a Cap'n Web call, which
 * carries structured-clone values. It is withheld rather than exposed-and-failing, and it is
 * NAMED as withheld for transport rather than for policy, because the fix differs: a caller that
 * wants a run's events polls `tasks_get_run`, while a caller that wants a denied operation asks
 * its operator to change the policy.
 */
function relayable(binding: GatekeeperBinding): boolean {
  return binding.result === 'value'
}

function compileTier(name: string, tier: TierPolicy): CompiledTier {
  if (!MINTABLE_SCOPES.includes(tier.keyScope)) {
    throw new PolicyError(
      `Tier '${name}' declares keyScope '${tier.keyScope}', which POST /api/v1/keys cannot mint ` +
        `(it mints ${MINTABLE_SCOPES.join(', ')}). An admin-scoped tier would hand a caller the ` +
        "Gatekeeper's own provisioning credential; grant the operations it needs at 'decide' instead.",
    )
  }

  const withinScope = bindingsWithinScope(tier.keyScope)
  const withinScopeNames = new Set(withinScope.map((binding) => binding.name))
  const deny = new Set(tier.deny ?? [])

  // Both lists are checked against the LIVE table first: a misspelled or retired name is an
  // operator error with a fix, and silently ignoring it would make a deny read as enforced.
  for (const [field, names] of [
    ['allow', tier.allow === '*' ? [] : tier.allow],
    ['deny', tier.deny ?? []],
  ] as const) {
    for (const bindingName of names) {
      if (!bindingByName(bindingName)) {
        throw new PolicyError(
          `Tier '${name}' names '${bindingName}' in ${field}, which this deployment's operation ` +
            'table does not carry. Check the spelling, or upgrade @cat-factory/gatekeeper-bindings ' +
            'if the operation is newer than this package.',
        )
      }
    }
  }

  if (tier.allow !== '*') {
    for (const bindingName of tier.allow) {
      if (!withinScopeNames.has(bindingName) && !deny.has(bindingName)) {
        const binding = bindingByName(bindingName)
        throw new PolicyError(
          `Tier '${name}' allows '${bindingName}', whose scope floor is '${binding?.minScope}', but ` +
            `the tier's keyScope is '${tier.keyScope}'. Raise the tier's keyScope or drop the ` +
            'operation: a granted method its key cannot call would refuse on every call.',
        )
      }
    }
  }

  const allowed = tier.allow === '*' ? withinScopeNames : new Set(tier.allow)
  const granted: GatekeeperBinding[] = []
  const withheld: WithheldBinding[] = []

  for (const binding of withinScope) {
    if (deny.has(binding.name)) {
      withheld.push({
        name: binding.name,
        reason: 'denied_by_policy',
        detail: `Tier '${name}' denies it.`,
      })
      continue
    }
    if (!allowed.has(binding.name)) {
      withheld.push({
        name: binding.name,
        reason: 'not_in_policy',
        detail: `Tier '${name}' does not allow it.`,
      })
      continue
    }
    if (!relayable(binding)) {
      withheld.push({
        name: binding.name,
        reason: 'not_relayable',
        detail: `Its result is a ${binding.result}, which a Cap'n Web call cannot carry.`,
      })
      continue
    }
    granted.push(binding)
  }

  for (const binding of bindingByScopeGap(withinScopeNames)) {
    withheld.push({
      name: binding.name,
      reason: 'above_key_scope',
      detail: `Its floor is '${binding.minScope}'; this tier's key is '${tier.keyScope}'.`,
    })
  }

  return {
    name,
    description: tier.description,
    keyScope: tier.keyScope,
    granted,
    withheld,
    mask: tier.mask ?? [],
  }
}

/** Every binding the deployment serves that the tier's own key could not call. */
function bindingByScopeGap(withinScope: ReadonlySet<string>): GatekeeperBinding[] {
  return bindingsWithinScope('admin').filter((binding) => !withinScope.has(binding.name))
}

/**
 * Compile a policy against the live operation table, or throw a {@link PolicyError} naming the
 * first thing an operator has to fix.
 */
export function compilePolicy(policy: GatekeeperPolicy): CompiledPolicy {
  const tiers = new Map<string, CompiledTier>()
  for (const [name, tier] of Object.entries(policy.tiers)) {
    tiers.set(name, compileTier(name, tier))
  }

  if (policy.defaultTier !== null && !tiers.has(policy.defaultTier)) {
    throw new PolicyError(
      `defaultTier is '${policy.defaultTier}', which is not one of the declared tiers ` +
        `(${[...tiers.keys()].join(', ')}).`,
    )
  }
  for (const [actor, tierName] of Object.entries(policy.grants)) {
    if (!tiers.has(tierName)) {
      throw new PolicyError(
        `Actor '${actor}' is granted tier '${tierName}', which is not declared.`,
      )
    }
  }

  return { defaultTier: policy.defaultTier, tiers, grants: new Map(Object.entries(policy.grants)) }
}

/**
 * The tier an actor holds, or a refusal.
 *
 * Note what is NOT here: nothing the CALLER sends picks a tier. The OS authenticates the person
 * and the Gatekeeper resolves what that person may do, so a compromised or confused agent cannot
 * ask for a better one.
 */
export function tierForActor(policy: CompiledPolicy, actorId: string): CompiledTier | null {
  const name = policy.grants.get(actorId) ?? policy.defaultTier
  if (name === null) return null
  return policy.tiers.get(name) ?? null
}

/**
 * What the OS needs to run its own approval governance over a call: the consequence the platform
 * annotates, with the cautious default already applied.
 */
export function describeBinding(binding: GatekeeperBinding): {
  name: string
  summary: string
  minScope: PublicApiScope
  readOnly: boolean
  destructive: boolean
  idempotent: boolean
  pathParams: readonly string[]
  queryParams: readonly string[]
  hasBody: boolean
} {
  const consequence = resolveConsequence(binding)
  return {
    name: binding.name,
    summary: binding.summary,
    minScope: binding.minScope,
    readOnly: binding.readOnly,
    destructive: consequence.destructive,
    idempotent: consequence.idempotent,
    pathParams: binding.pathParams,
    queryParams: binding.queryParams,
    hasBody: binding.hasBody,
  }
}
