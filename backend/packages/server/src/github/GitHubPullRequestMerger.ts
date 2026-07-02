import type { BlockRepository, GitHubClient, PullRequestMerger } from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import { logger } from '../observability/logger.js'

export interface GitHubPullRequestMergerDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref (number to merge). */
  blockRepository: BlockRepository
}

/**
 * The single place a block's pull request is actually merged on GitHub. The
 * execution engine calls this (via the {@link PullRequestMerger} port) before
 * flipping a task to `done`, so `done` provably means "merged". Throws if the
 * block has no PR number, the repo can't be resolved, or GitHub rejects the merge
 * (failing required checks, conflicts) — the engine then leaves the block awaiting
 * a manual merge / raises a review notification.
 */
export class GitHubPullRequestMerger implements PullRequestMerger {
  constructor(private readonly deps: GitHubPullRequestMergerDependencies) {}

  async mergeForBlock(workspaceId: string, blockId: string): Promise<void> {
    const target = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!target) {
      throw new Error(`No GitHub repository resolved for block '${blockId}'; cannot merge.`)
    }
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    const number = block?.pullRequest?.number
    if (number === undefined) {
      throw new Error(`Block '${blockId}' has no pull-request number to merge.`)
    }
    await this.deps.githubClient.mergePullRequest(
      target.installationId,
      { owner: target.owner, repo: target.name },
      number,
    )

    // Tear down the work branch now that it is merged. The branch is deterministic
    // per task (`cat-factory/<blockId>`), so leaving it behind would let a later
    // re-run of this block RESUME on already-merged commits — which a squash/rebase
    // merge would re-introduce wholesale (those commits are not ancestors of base),
    // and which for a merge-commit merge leaves a branch reachable from base that a
    // resumed run can't open a PR for ("No commits between ..."). Best-effort: a
    // failed delete must never undo or fail the completed merge — but log it, since a
    // silently-skipped delete is exactly what strands a resumable-but-empty branch.
    const branch = block?.pullRequest?.branch
    if (branch) {
      await this.deps.githubClient
        .deleteBranch(target.installationId, { owner: target.owner, repo: target.name }, branch)
        .catch((err: unknown) => {
          logger.warn(
            { workspaceId, blockId, branch, err },
            'mergeForBlock: failed to delete merged work branch (left behind)',
          )
        })
    }
  }
}
