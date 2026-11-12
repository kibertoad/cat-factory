import {
  OUTCOME_INLINE_MAX_BYTES_CEILING,
  type OutcomeStoragePolicy,
  type OutcomeStoragePolicyView,
  type SetOutcomeStoragePolicyInput,
} from '@cat-factory/contracts'
import {
  type OutcomeStoragePolicyRepository,
  type WorkspaceRepository,
  ValidationError,
  resolveOutcomeStoragePolicy,
} from '@cat-factory/kernel'

/** The stored tiers an outcome written from `workspaceId` folds, project tier included when named. */
export async function readOutcomeStorageTiers(
  deps: {
    outcomeStoragePolicyRepository?: OutcomeStoragePolicyRepository
    workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  },
  workspaceId: string,
  projectId?: string,
): Promise<{
  account: OutcomeStoragePolicy | null
  workspace: OutcomeStoragePolicy | null
  project: OutcomeStoragePolicy | null
}> {
  const policies = deps.outcomeStoragePolicyRepository
  if (!policies) return { account: null, workspace: null, project: null }
  const accountId = (await deps.workspaceRepository.accountOf(workspaceId)) ?? null
  const [account, workspace, project] = await Promise.all([
    accountId ? policies.get('account', accountId) : null,
    policies.get('workspace', workspaceId),
    projectId ? policies.get('project', projectId) : null,
  ])
  return { account, workspace, project }
}

export interface OutcomeStoragePolicyServiceDeps {
  outcomeStoragePolicyRepository: OutcomeStoragePolicyRepository
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  /** Refuses (404) a project the board does not mount. */
  assertProjectMounted: (workspaceId: string, projectId: string) => Promise<void>
}

/**
 * The outcome-storage policy tiers. A board reads every tier that applies to it and sets its
 * own or a project it mounts; the account tier is set at the account. Absence means inherit, so
 * clearing a tier stores nothing rather than a null.
 */
export class OutcomeStoragePolicyService {
  constructor(private readonly deps: OutcomeStoragePolicyServiceDeps) {}

  async view(workspaceId: string, projectId?: string): Promise<OutcomeStoragePolicyView> {
    if (projectId) await this.deps.assertProjectMounted(workspaceId, projectId)
    const tiers = await readOutcomeStorageTiers(this.deps, workspaceId, projectId)
    return {
      account: tiers.account,
      workspace: tiers.workspace,
      ...(projectId ? { project: tiers.project } : {}),
      effective: resolveOutcomeStoragePolicy({
        ...tiers,
        facadeInlineCeilingBytes: OUTCOME_INLINE_MAX_BYTES_CEILING,
      }),
    }
  }

  async set(
    workspaceId: string,
    input: SetOutcomeStoragePolicyInput,
  ): Promise<OutcomeStoragePolicyView> {
    const repo = this.deps.outcomeStoragePolicyRepository
    if (input.tier === 'workspace') {
      await repo.set('workspace', workspaceId, normalise(input.policy))
      return this.view(workspaceId)
    }
    await this.deps.assertProjectMounted(workspaceId, input.projectId)
    await repo.set('project', input.projectId, normalise(input.policy))
    return this.view(workspaceId, input.projectId)
  }

  async getAccount(accountId: string): Promise<OutcomeStoragePolicy | null> {
    return this.deps.outcomeStoragePolicyRepository.get('account', accountId)
  }

  async setAccount(
    accountId: string,
    policy: OutcomeStoragePolicy | null,
  ): Promise<OutcomeStoragePolicy | null> {
    const normalised = normalise(policy)
    await this.deps.outcomeStoragePolicyRepository.set('account', accountId, normalised)
    return normalised
  }
}

/** A policy that sets no field is the same fact as no policy, and is stored as none. */
function normalise(policy: OutcomeStoragePolicy | null): OutcomeStoragePolicy | null {
  if (!policy) return null
  const set: OutcomeStoragePolicy = {
    ...(policy.inlineMaxBytes !== undefined ? { inlineMaxBytes: policy.inlineMaxBytes } : {}),
    ...(policy.offload !== undefined ? { offload: policy.offload } : {}),
  }
  if (Object.keys(set).length === 0) return null
  if (set.inlineMaxBytes !== undefined && set.inlineMaxBytes > OUTCOME_INLINE_MAX_BYTES_CEILING) {
    throw new ValidationError('The inline threshold is above the platform ceiling')
  }
  return set
}
