import type {
  BlockRepository,
  CiStatusProvider,
  CiStatusReport,
  GitHubClient,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'

export interface GitHubCiStatusProviderDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref (head branch). */
  blockRepository: BlockRepository
}

/**
 * Reads a block's CI status from GitHub for the `ci` gate: resolve the PR head
 * branch → its head commit (latest commit on the branch) → the check runs for
 * that commit. Returns `{ headSha: null, checks: [] }` when there is no resolvable
 * PR branch yet (the engine treats that as "nothing to gate").
 */
export class GitHubCiStatusProvider implements CiStatusProvider {
  constructor(private readonly deps: GitHubCiStatusProviderDependencies) {}

  async getStatus(workspaceId: string, blockId: string): Promise<CiStatusReport> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const branch = block?.pullRequest?.branch
    if (!branch) return { headSha: null, checks: [] }

    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) return { headSha: null, checks: [] }
    const ref = { owner: target.owner, repo: target.name }

    // The head commit of the PR branch is the latest commit listed on that ref.
    const commits = await this.deps.githubClient.listCommits(target.installationId, ref, {
      sha: branch,
    })
    const headSha = commits.items[0]?.sha ?? null
    if (!headSha) return { headSha: null, checks: [] }

    const checks = await this.deps.githubClient.listCheckRuns(target.installationId, ref, headSha)
    return {
      headSha,
      checks: checks.items.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
      })),
    }
  }
}
