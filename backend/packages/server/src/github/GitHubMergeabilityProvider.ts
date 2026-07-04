import type {
  BlockRepository,
  GitHubClient,
  MergeabilityReport,
  MergeabilityVerdict,
  PullRequestMergeabilityProvider,
  RepoMergeability,
} from '@cat-factory/kernel'
import { allPullRequests } from '@cat-factory/contracts'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import { splitRepo } from './GitHubCiStatusProvider.js'

export interface GitHubMergeabilityProviderDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's OWN work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref(s) (own + peers). */
  blockRepository: BlockRepository
}

/**
 * Reads a block's PR mergeability from GitHub for the `conflicts` gate — for a single-repo
 * task, its one PR; for a MULTI-REPO task (service-connections phase 4), EVERY PR it opened
 * (own-service + peers). Returns `{ repos: [] }` when there is no resolvable PR (the engine
 * treats that as "nothing to gate"). Maps GitHub's lazily-computed `mergeable` /
 * `mergeable_state` to the engine's small verdict: only `mergeable_state === 'dirty'` is a
 * real conflict; a null/`unknown` reading means GitHub is still computing it (poll again);
 * everything else (clean / behind / blocked / unstable) has no conflict to resolve.
 */
export class GitHubMergeabilityProvider implements PullRequestMergeabilityProvider {
  constructor(private readonly deps: GitHubMergeabilityProviderDependencies) {}

  async getMergeability(workspaceId: string, blockId: string): Promise<MergeabilityReport> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block) return { repos: [] }
    const prs = allPullRequests(block)
    if (prs.length === 0) return { repos: [] }

    const ownTarget = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!ownTarget) return { repos: [] }
    const installationId = ownTarget.installationId

    // One remote round-trip per PR (each is a distinct GitHub PR). The block is read once.
    const repos: RepoMergeability[] = []
    for (const pr of prs) {
      const [owner, name] = pr.repo ? splitRepo(pr.repo) : [ownTarget.owner, ownTarget.name]
      const repoFull = `${owner}/${name}`
      const number = pr.ref.number
      if (number === undefined) {
        repos.push({
          repo: repoFull,
          ...(pr.frameId ? { frameId: pr.frameId } : {}),
          headSha: null,
          verdict: 'unknown',
        })
        continue
      }
      const { mergeable, mergeableState, headSha } =
        await this.deps.githubClient.getPullRequestMergeability(
          installationId,
          { owner, repo: name },
          number,
        )
      repos.push({
        repo: repoFull,
        ...(pr.frameId ? { frameId: pr.frameId } : {}),
        headSha,
        verdict: classifyMergeability(mergeable, mergeableState),
      })
    }
    return { repos }
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
