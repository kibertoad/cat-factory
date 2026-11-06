import {
  DEFAULT_FINDINGS_INLINE_MAX_BYTES,
  type FindingsStoragePolicy,
} from '@cat-factory/contracts'

/** A findings-storage policy with every field decided. */
export interface EffectiveFindingsStoragePolicy {
  inlineMaxBytes: number
  offload: 'enabled' | 'disabled'
}

/**
 * The account, workspace and project tiers folded narrowest-first: a field a narrower tier sets
 * wins, an absent field inherits. `facadeInlineCeilingBytes` is the runtime's own row cap, which
 * no tier can raise.
 */
export function resolveFindingsStoragePolicy(input: {
  account?: FindingsStoragePolicy | null
  workspace?: FindingsStoragePolicy | null
  project?: FindingsStoragePolicy | null
  facadeInlineCeilingBytes: number
}): EffectiveFindingsStoragePolicy {
  const tiers = [input.project, input.workspace, input.account]
  const pick = <K extends keyof FindingsStoragePolicy>(field: K) =>
    tiers.find((tier) => tier?.[field] !== undefined)?.[field]
  const inlineMaxBytes = pick('inlineMaxBytes') ?? DEFAULT_FINDINGS_INLINE_MAX_BYTES
  return {
    inlineMaxBytes: Math.min(inlineMaxBytes, input.facadeInlineCeilingBytes),
    offload: pick('offload') ?? 'enabled',
  }
}

export type FindingsPlacement =
  | { placement: 'inline' }
  | { placement: 'offload' }
  | { placement: 'refused'; reason: 'findings_too_large_for_inline' }

/**
 * Where a revision body of `bytes` is stored. Over the threshold it is offloaded to the
 * account's blob store; when offload is disabled or no store is configured, a body that still
 * fits under the facade's own ceiling stays inline, and one that does not is refused loudly
 * rather than truncated.
 */
export function placeFindingsBody(input: {
  bytes: number
  policy: EffectiveFindingsStoragePolicy
  facadeInlineCeilingBytes: number
  blobStoreAvailable: boolean
}): FindingsPlacement {
  if (input.bytes <= input.policy.inlineMaxBytes) return { placement: 'inline' }
  if (input.policy.offload === 'enabled' && input.blobStoreAvailable)
    return { placement: 'offload' }
  if (input.bytes <= input.facadeInlineCeilingBytes) return { placement: 'inline' }
  return { placement: 'refused', reason: 'findings_too_large_for_inline' }
}
