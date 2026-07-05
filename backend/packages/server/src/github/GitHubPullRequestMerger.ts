import type {
  BlockRepository,
  GitHubClient,
  MergeAllOutcome,
  MergePrEntry,
  PullRequestMerger,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from '../agents/ContainerAgentExecutor.js'
import { splitRepo } from './repoFullName.js'
import { logger } from '../observability/logger.js'

export interface GitHubPullRequestMergerDependencies {
  githubClient: GitHubClient
  /** Resolves the repo (installation + owner/name) a block's OWN work targets. */
  resolveRepoTarget: ResolveRepoTarget
  /** Reads the block's recorded PR ref(s) (own + peers). */
  blockRepository: BlockRepository
}

/**
 * The single place a block's pull request(s) are actually merged on GitHub. The execution
 * engine calls this (via the {@link PullRequestMerger} port) before flipping a task to
 * `done`, so `done` provably means "merged". For a single-repo task it merges the one PR;
 * for a MULTI-REPO task (service-connections phase 4) it merges the engine-ordered list
 * (provider-before-consumer) sequentially, stopping at the FIRST failure — cross-repo merges
 * cannot be atomic, so the engine surfaces a partial merge for a human to finish. A workspace
 * has one GitHub installation today, so every PR merges under the own repo's installation id.
 */
export class GitHubPullRequestMerger implements PullRequestMerger {
  constructor(private readonly deps: GitHubPullRequestMergerDependencies) {}

  async mergePullRequests(
    workspaceId: string,
    blockId: string,
    prs: MergePrEntry[],
  ): Promise<MergeAllOutcome> {
    const ownTarget = await this.deps.resolveRepoTarget(workspaceId, blockId)
    if (!ownTarget) {
      throw new Error(`No GitHub repository resolved for block '${blockId}'; cannot merge.`)
    }
    const installationId = ownTarget.installationId

    const merged: MergePrEntry[] = []
    for (let i = 0; i < prs.length; i++) {
      const entry = prs[i]!
      const [owner, name] = entry.repo ? splitRepo(entry.repo) : [ownTarget.owner, ownTarget.name]
      const number = entry.ref.number
      if (number === undefined) {
        // A PR ref with no number can't be merged — treat as a failure so the run doesn't
        // silently report "done" while a change is left open.
        return {
          merged,
          failed: { entry, error: `PR for '${owner}/${name}' has no number to merge.` },
          skipped: prs.slice(i + 1),
        }
      }
      const ref = { owner, repo: name }
      try {
        await this.deps.githubClient.mergePullRequest(installationId, ref, number)
      } catch (err) {
        return {
          merged,
          failed: { entry, error: err instanceof Error ? err.message : String(err) },
          skipped: prs.slice(i + 1),
        }
      }
      merged.push(entry)
      // Tear down the merged work branch (deterministic per task, `cat-factory/<blockId>`);
      // leaving it strands a resumable-but-merged branch (see the single-repo note that used
      // to live here). Best-effort — a failed delete must never undo the completed merge.
      const branch = entry.ref.branch
      if (branch) {
        await this.deps.githubClient
          .deleteBranch(installationId, ref, branch)
          .catch((e: unknown) => {
            logger.warn(
              { workspaceId, blockId, repo: `${owner}/${name}`, branch, err: e },
              'mergePullRequests: failed to delete merged work branch (left behind)',
            )
          })
      }
    }
    return { merged, failed: null, skipped: [] }
  }
}
