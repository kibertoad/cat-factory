import type {
  BlockRepository,
  CiStatusProvider,
  CiStatusReport,
  GitHubClient,
  RepoCiStatus,
} from '@cat-factory/kernel'
import { allPullRequests } from '@cat-factory/contracts'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'

export interface GitHubCiStatusProviderDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's OWN work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref(s) (own + peers). */
  blockRepository: BlockRepository
}

/**
 * Reads a block's CI status from GitHub for the `ci` gate. For a single-repo task it
 * resolves the PR head branch → its head commit → the check runs for that commit. For a
 * MULTI-REPO task (service-connections phase 4) it does the same for EVERY PR the task
 * opened (own-service + peer-service repos), returning one {@link RepoCiStatus} each so the
 * gate can aggregate the verdict and name the failing repo(s). A workspace has one GitHub
 * installation today, so every PR is read under the own repo's installation id.
 * Returns `{ repos: [] }` when there is no resolvable PR branch (the engine treats that as
 * "nothing to gate").
 */
export class GitHubCiStatusProvider implements CiStatusProvider {
  constructor(private readonly deps: GitHubCiStatusProviderDependencies) {}

  async getStatus(workspaceId: string, blockId: string): Promise<CiStatusReport> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block) return { repos: [] }
    const prs = allPullRequests(block)
    if (prs.length === 0) return { repos: [] }

    // A workspace has exactly one GitHub installation today; every PR (own + peer) is read
    // under it. Resolve the own target once for the installation id + own owner/name.
    const ownTarget = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!ownTarget) return { repos: [] }
    const installationId = ownTarget.installationId

    // One remote round-trip per PR is unavoidable — each PR is a distinct GitHub repo/branch
    // with no cross-repo check-runs API. The block itself is read once (not per PR), so this
    // is not a repository-layer N+1.
    const repos: RepoCiStatus[] = []
    for (const pr of prs) {
      const [owner, name] = pr.repo ? splitRepo(pr.repo) : [ownTarget.owner, ownTarget.name]
      const repoFull = `${owner}/${name}`
      const branch = pr.ref.branch
      if (!branch) {
        repos.push({ repo: repoFull, headSha: null, checks: [] })
        continue
      }
      const ref = { owner, repo: name }
      const commits = await this.deps.githubClient.listCommits(installationId, ref, { sha: branch })
      const headSha = commits.items[0]?.sha ?? null
      if (!headSha) {
        repos.push({ repo: repoFull, headSha: null, checks: [] })
        continue
      }
      const checks = await this.deps.githubClient.listCheckRuns(installationId, ref, headSha)
      repos.push({
        repo: repoFull,
        headSha,
        checks: checks.items.map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          url: c.htmlUrl ?? null,
        })),
      })
    }
    return { repos }
  }
}

/** Split an `owner/name` full name into its parts (an unslashed value is treated as the name). */
export function splitRepo(full: string): [string, string] {
  const i = full.indexOf('/')
  return i === -1 ? ['', full] : [full.slice(0, i), full.slice(i + 1)]
}
