import { DEFAULT_OUTCOME_INLINE_MAX_BYTES, type OutcomeStoragePolicy } from '@cat-factory/contracts'

/** An outcome-storage policy with every field decided. */
export interface EffectiveOutcomeStoragePolicy {
  /** Never above `facadeInlineCeilingBytes`. */
  inlineMaxBytes: number
  offload: 'enabled' | 'disabled'
  /** The runtime's own row cap, carried so placement judges against the cap the policy did. */
  facadeInlineCeilingBytes: number
}

/**
 * The account, workspace and project tiers folded narrowest-first: a field a narrower tier sets
 * wins, an absent field inherits. `facadeInlineCeilingBytes` is the runtime's own row cap, which
 * no tier can raise.
 */
export function resolveOutcomeStoragePolicy(input: {
  account?: OutcomeStoragePolicy | null
  workspace?: OutcomeStoragePolicy | null
  project?: OutcomeStoragePolicy | null
  facadeInlineCeilingBytes: number
}): EffectiveOutcomeStoragePolicy {
  const tiers = [input.project, input.workspace, input.account]
  const pick = <K extends keyof OutcomeStoragePolicy>(field: K) =>
    tiers.find((tier) => tier?.[field] !== undefined)?.[field]
  const inlineMaxBytes = pick('inlineMaxBytes') ?? DEFAULT_OUTCOME_INLINE_MAX_BYTES
  return {
    inlineMaxBytes: Math.min(inlineMaxBytes, input.facadeInlineCeilingBytes),
    offload: pick('offload') ?? 'enabled',
    facadeInlineCeilingBytes: input.facadeInlineCeilingBytes,
  }
}

export type OutcomePlacement =
  | { placement: 'inline' }
  | { placement: 'offload' }
  | { placement: 'refused'; reason: 'outcome_too_large_for_inline' }

/**
 * Where a revision body of `bytes` is stored. Over the threshold it is offloaded to the
 * account's blob store; when offload is disabled or no store is configured, a body that still
 * fits under the facade's own ceiling stays inline, and one that does not is refused loudly
 * rather than truncated.
 */
export function placeOutcomeBody(input: {
  bytes: number
  policy: EffectiveOutcomeStoragePolicy
  blobStoreAvailable: boolean
}): OutcomePlacement {
  if (input.bytes <= input.policy.inlineMaxBytes) return { placement: 'inline' }
  if (input.policy.offload === 'enabled' && input.blobStoreAvailable)
    return { placement: 'offload' }
  if (input.bytes <= input.policy.facadeInlineCeilingBytes) return { placement: 'inline' }
  return { placement: 'refused', reason: 'outcome_too_large_for_inline' }
}
