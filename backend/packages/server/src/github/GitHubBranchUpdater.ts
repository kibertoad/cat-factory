import type {
  BlockRepository,
  BranchUpdater,
  BranchUpdateOutcome,
  GitHubClient,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'

export interface GitHubBranchUpdaterDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref (branch). */
  blockRepository: BlockRepository
}

/**
 * Merges a repo's default branch INTO a block's open PR branch, server-side, for the
 * human-testing gate's "pull latest main + redeploy" action. Resolves the PR head branch and
 * the repo default branch, then calls `GitHubClient.mergeBranch` with `base` = the PR branch
 * (merge INTO) and `head` = the default branch (merge IN). A clean merge / nothing-to-do lets
 * the gate just rebuild the env; a conflict tells it to escalate to the conflict-resolver.
 */
export class GitHubBranchUpdater implements BranchUpdater {
  constructor(private readonly deps: GitHubBranchUpdaterDependencies) {}

  async updateFromBase(workspaceId: string, blockId: string): Promise<BranchUpdateOutcome> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const branch = block?.pullRequest?.branch
    if (!branch) {
      throw new ConflictError('The task has no open PR branch to pull main into')
    }
    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) {
      throw new ConflictError('Could not resolve the repository for this task')
    }
    const ref = { owner: target.owner, repo: target.name }
    const gh = this.deps.githubClient
    // A provider with no server-side merge-branch-into-branch endpoint (GitLab) advances the PR
    // branch by REBASING the open MR onto its target — the equivalent "bring the PR branch up to
    // date with base" operation. Prefer it when exposed and the PR number is known; it rebases
    // against the MR's own target branch, so no default-branch lookup is needed.
    const number = block?.pullRequest?.number
    if (gh.rebasePullRequest && number != null) {
      return gh.rebasePullRequest(target.installationId, ref, number)
    }
    const repo = await gh.getRepo(target.installationId, ref)
    const base = repo.defaultBranch
    if (!base) {
      throw new ConflictError('The repository has no default branch to pull from')
    }
    // base = the PR branch (merge INTO); head = the default branch (merge IN).
    return gh.mergeBranch(target.installationId, ref, {
      base: branch,
      head: base,
    })
  }
}
