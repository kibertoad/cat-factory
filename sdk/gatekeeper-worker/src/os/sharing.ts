// Whether one account may be shown what another has already read through this resource.
//
// The contract's requirement is exact and it is not "is this person trusted": `addObserver` must
// verify that the new viewer could DIRECTLY READ everything historically observed through the
// resource, and throw to block the share otherwise. Slice 8 shipped the blanket refusal, which was
// the right default while there was no rule worth writing down. This is the rule.
//
// It rests on one fact about this Gatekeeper that makes the question answerable at all: a resource
// object is bound FOR ONE ACCOUNT (`ResourceProps.accountId`), so every observation ever made
// through it was made at that account's tier. There is no observation log and there does not need
// to be one, because the tier is an upper bound on what any of those reads could have returned.
// So the test is a comparison of two compiled tiers:
//
//   1. The observer's tier GRANTS every operation the owner's tier grants. An operation the
//      observer does not hold is one they could not have made themselves, whatever they are shown.
//   2. The observer's MASK hides nothing the owner's does not. Masking is redaction on the way
//      out, so a field the observer's tier blanks is a field they cannot read directly, even
//      through an operation they hold.
//   3. The owner's tier reaches NO TELEMETRY SINK. Those reads serve captured agent text and are
//      described with `prohibitAllSharing`, which says the data may not be shared onward with any
//      observer whatever their own access is. Since nothing here records which reads were actually
//      made, a tier that COULD have made one is a tier whose observations may include it.
//
// Every failure is a refusal that names which of the three it is, because they need different
// answers: a grant an operator can widen, a mask they can align, and one they must not "fix" at
// all. And an observer this Gatekeeper cannot identify is refused separately again, because
// "unknown" and "not permitted" are the same outcome and opposite facts.
//
// The rule is deliberately conservative in the one direction that costs nothing but a share:
// every accepted observer can read everything the owner's tier can, so no observation ever needs
// excluding afterwards and `ObservationDescription.excludeObservers` stays unused rather than
// being a second, weaker gate on the same question.

import { GatekeeperError } from '../errors.js'
import type { CompiledTier } from '../policy/compile.js'

/** How many withheld operations a refusal names before it stops listing them. */
const NAMED_OPERATIONS = 5

/** What a verifier stub answers: the account the workspace is asking us to share with. */
interface ObserverIdentity {
  accountId?: unknown
}

/**
 * Resolve the account behind an observer's verifier, or refuse.
 *
 * The verifier is the contract's own identity token: another vendor's gatekeeper is handed one,
 * and the only thing it carries is who its holder is. Ours answers `{ accountId }`, so a stub that
 * answers anything else did not come from this vendor and cannot be resolved against this
 * deployment's policy.
 */
export async function identifyObserver(user: unknown): Promise<string> {
  const verifier = user as Partial<{ describe: () => Promise<ObserverIdentity> }>
  if (typeof verifier?.describe !== 'function') {
    throw new GatekeeperError(
      'sharing_unverifiable',
      'The observer offered no verifier this Gatekeeper can question, so there is no account to ' +
        'resolve a tier for. A share is refused rather than granted to an identity nobody stated.',
    )
  }
  let identity: ObserverIdentity
  try {
    identity = await verifier.describe()
  } catch (error) {
    throw new GatekeeperError(
      'sharing_unverifiable',
      `The observer's verifier could not be questioned (${describeError(error)}), so the share ` +
        'is refused: an identity this Gatekeeper failed to read is not an identity it may assume.',
    )
  }
  if (typeof identity?.accountId !== 'string' || identity.accountId.length === 0) {
    throw new GatekeeperError(
      'sharing_unverifiable',
      "The observer's verifier named no account, so this deployment's policy has nothing to " +
        'resolve a tier against. Observers must hold an account on this same Gatekeeper.',
    )
  }
  return identity.accountId
}

/**
 * Refuse the share unless the observer could have read all of it themselves.
 *
 * Takes the two COMPILED tiers rather than resolving them, so the rule is testable without a
 * policy, a Worker or an account: what it decides is a comparison, and everything else is lookup.
 */
export function assertObserverMaySee(deps: {
  observerId: string
  observerAccount: string
  owner: CompiledTier
  observer: CompiledTier
}): void {
  const { owner, observer } = deps

  const captured = owner.granted.filter((binding) => binding.telemetrySink !== undefined)
  if (captured.length > 0) {
    throw new GatekeeperError(
      'sharing_refused',
      `This resource is bound at tier '${owner.name}', which can read captured agent text ` +
        `(${names(captured.map((binding) => binding.name))}). Those reads are marked as not ` +
        'shareable onward whatever the viewer holds, and nothing here records which of them were ' +
        `actually made, so the share to '${deps.observerId}' is refused. A tier without the ` +
        'telemetry operations can be shared.',
    )
  }

  const held = new Set(observer.granted.map((binding) => binding.name))
  const unreachable = owner.granted.filter((binding) => !held.has(binding.name))
  if (unreachable.length > 0) {
    throw new GatekeeperError(
      'sharing_refused',
      `Account '${deps.observerAccount}' holds tier '${observer.name}', which does not grant ` +
        `${names(unreachable.map((binding) => binding.name))}. This resource is bound at tier ` +
        `'${owner.name}', so it may already have read those, and the share would show them what ` +
        'they cannot read for themselves.',
    )
  }

  const ownerMask = new Set(owner.mask)
  const extraMask = observer.mask.filter((path) => !ownerMask.has(path))
  if (extraMask.length > 0) {
    throw new GatekeeperError(
      'sharing_refused',
      `Tier '${observer.name}' masks ${names(extraMask)}, which tier '${owner.name}' does not. A ` +
        'masked field is one this observer cannot read directly even through an operation they ' +
        'hold, so the share is refused rather than served with the redaction undone.',
    )
  }
}

/** A bounded list: enough to act on, never the whole surface pasted into a refusal. */
function names(all: readonly string[]): string {
  const shown = all
    .slice(0, NAMED_OPERATIONS)
    .map((name) => `'${name}'`)
    .join(', ')
  return all.length > NAMED_OPERATIONS
    ? `${shown} and ${all.length - NAMED_OPERATIONS} more`
    : shown
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
