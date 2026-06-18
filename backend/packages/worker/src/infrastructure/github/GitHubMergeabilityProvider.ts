import type {
  BlockRepository,
  GitHubClient,
  MergeabilityReport,
  MergeabilityVerdict,
  PullRequestMergeabilityProvider,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../ai/ContainerAgentExecutor'

export interface GitHubMergeabilityProviderDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref (number). */
  blockRepository: BlockRepository
}

/**
 * Reads a block's PR mergeability from GitHub for the `conflicts` gate. Returns
 * `{ headSha: null, verdict: 'unknown' }` when there is no resolvable PR (the engine
 * treats that as "nothing to gate"). Maps GitHub's lazily-computed `mergeable` /
 * `mergeable_state` to the engine's small verdict: only `mergeable_state === 'dirty'`
 * is a real conflict; a null/`unknown` reading means GitHub is still computing it
 * (poll again); everything else (clean / behind / blocked / unstable) has no
 * conflict to resolve.
 */
export class GitHubMergeabilityProvider implements PullRequestMergeabilityProvider {
  constructor(private readonly deps: GitHubMergeabilityProviderDependencies) {}

  async getMergeability(workspaceId: string, blockId: string): Promise<MergeabilityReport> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const number = block?.pullRequest?.number
    if (number === undefined) return { headSha: null, verdict: 'unknown' }

    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) return { headSha: null, verdict: 'unknown' }

    const { mergeable, mergeableState, headSha } =
      await this.deps.githubClient.getPullRequestMergeability(
        target.installationId,
        { owner: target.owner, repo: target.name },
        number,
      )
    return { headSha, verdict: classifyMergeability(mergeable, mergeableState) }
  }
}

/** Map GitHub's `mergeable` / `mergeable_state` to the engine's mergeability verdict. */
export function classifyMergeability(
  mergeable: boolean | null,
  mergeableState: string,
): MergeabilityVerdict {
  // 'dirty' is GitHub's signal that the PR conflicts with its base.
  if (mergeableState === 'dirty') return 'conflicted'
  // Mergeability is computed asynchronously: null / 'unknown' means "not ready yet".
  if (mergeable === null || mergeableState === 'unknown' || mergeableState === '') return 'unknown'
  // clean / behind / blocked / unstable / has_hooks: no merge conflict to resolve.
  return 'mergeable'
}
