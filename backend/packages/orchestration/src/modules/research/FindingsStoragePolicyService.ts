import {
  FINDINGS_INLINE_MAX_BYTES_CEILING,
  type FindingsStoragePolicy,
  type FindingsStoragePolicyView,
  type SetFindingsStoragePolicyInput,
} from '@cat-factory/contracts'
import {
  type FindingsStoragePolicyRepository,
  type WorkspaceRepository,
  ValidationError,
  resolveFindingsStoragePolicy,
} from '@cat-factory/kernel'

/** The stored tiers a revision written from `workspaceId` folds, project tier included when named. */
export async function readFindingsStorageTiers(
  deps: {
    findingsStoragePolicyRepository?: FindingsStoragePolicyRepository
    workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  },
  workspaceId: string,
  projectId?: string,
): Promise<{
  account: FindingsStoragePolicy | null
  workspace: FindingsStoragePolicy | null
  project: FindingsStoragePolicy | null
}> {
  const policies = deps.findingsStoragePolicyRepository
  if (!policies) return { account: null, workspace: null, project: null }
  const accountId = (await deps.workspaceRepository.accountOf(workspaceId)) ?? null
  const [account, workspace, project] = await Promise.all([
    accountId ? policies.get('account', accountId) : null,
    policies.get('workspace', workspaceId),
    projectId ? policies.get('project', projectId) : null,
  ])
  return { account, workspace, project }
}

export interface FindingsStoragePolicyServiceDeps {
  findingsStoragePolicyRepository: FindingsStoragePolicyRepository
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  /** Refuses (404) a project the board does not mount. */
  assertProjectMounted: (workspaceId: string, projectId: string) => Promise<void>
}

/**
 * The findings-storage policy tiers. A board reads every tier that applies to it and sets its
 * own or a project it mounts; the account tier is set at the account. Absence means inherit, so
 * clearing a tier stores nothing rather than a null.
 */
export class FindingsStoragePolicyService {
  constructor(private readonly deps: FindingsStoragePolicyServiceDeps) {}

  async view(workspaceId: string, projectId?: string): Promise<FindingsStoragePolicyView> {
    if (projectId) await this.deps.assertProjectMounted(workspaceId, projectId)
    const tiers = await readFindingsStorageTiers(this.deps, workspaceId, projectId)
    return {
      account: tiers.account,
      workspace: tiers.workspace,
      ...(projectId ? { project: tiers.project } : {}),
      effective: resolveFindingsStoragePolicy({
        ...tiers,
        facadeInlineCeilingBytes: FINDINGS_INLINE_MAX_BYTES_CEILING,
      }),
    }
  }

  async set(
    workspaceId: string,
    input: SetFindingsStoragePolicyInput,
  ): Promise<FindingsStoragePolicyView> {
    const repo = this.deps.findingsStoragePolicyRepository
    if (input.tier === 'workspace') {
      await repo.set('workspace', workspaceId, normalise(input.policy))
      return this.view(workspaceId)
    }
    await this.deps.assertProjectMounted(workspaceId, input.projectId)
    await repo.set('project', input.projectId, normalise(input.policy))
    return this.view(workspaceId, input.projectId)
  }

  async getAccount(accountId: string): Promise<FindingsStoragePolicy | null> {
    return this.deps.findingsStoragePolicyRepository.get('account', accountId)
  }

  async setAccount(
    accountId: string,
    policy: FindingsStoragePolicy | null,
  ): Promise<FindingsStoragePolicy | null> {
    const normalised = normalise(policy)
    await this.deps.findingsStoragePolicyRepository.set('account', accountId, normalised)
    return normalised
  }
}

/** A policy that sets no field is the same fact as no policy, and is stored as none. */
function normalise(policy: FindingsStoragePolicy | null): FindingsStoragePolicy | null {
  if (!policy) return null
  const set: FindingsStoragePolicy = {
    ...(policy.inlineMaxBytes !== undefined ? { inlineMaxBytes: policy.inlineMaxBytes } : {}),
    ...(policy.offload !== undefined ? { offload: policy.offload } : {}),
  }
  if (Object.keys(set).length === 0) return null
  if (set.inlineMaxBytes !== undefined && set.inlineMaxBytes > FINDINGS_INLINE_MAX_BYTES_CEILING) {
    throw new ValidationError('The inline threshold is above the platform ceiling')
  }
  return set
}
