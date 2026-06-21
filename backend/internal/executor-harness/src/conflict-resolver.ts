import type { ConflictResolverJob, ConflictResolverResult } from './job.js'
import { cloneRepo, commitAll, headCommit, mergeBranch, pushBranch, unmergedPaths } from './git.js'
import type { PiRunStats } from './pi.js'
import {
  agentNeverActed,
  agentOutputTail,
  NEVER_ACTED_CAUSE,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

// Async job execution for the merge-conflict resolver. When a PR cannot be merged
// because it conflicts with its base, the engine dispatches this: clone the PR head
// branch (full history), merge the base branch into it to surface the conflicts,
// run Pi to resolve them, complete the merge commit and push back onto the SAME
// branch (no new branch / PR) so the PR becomes mergeable and CI re-runs.
//
// Shares the thin workspace/Pi base (withWorkspace + runAgentInWorkspace) with the
// other agents; it diverges only in needing a full clone, a base→branch merge to
// produce the conflicts, and a guard that refuses to push a half-resolved tree.

/** Run one conflict-resolver job: clone → merge base → Pi resolves → push (same branch). */
export async function handleConflictResolver(
  job: ConflictResolverJob,
  opts: RunOptions = {},
): Promise<ConflictResolverResult> {
  const { signal } = opts
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  return withWorkspace('conflict', async (dir) => {
    log.info('conflict: cloning PR branch (full history)', trace)
    // Full clone so the merge base + `origin/<base>` are present for the merge.
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal,
      full: true,
    })
    const prTip = await headCommit(dir, signal)

    log.info('conflict: merging base into PR branch', { ...trace, base: job.repo.baseBranch })
    const clean = await mergeBranch(dir, job.repo.baseBranch, signal)

    let summary = ''
    let stats: PiRunStats = { toolCalls: 0, assistantChars: 0 }
    let usage: { inputTokens: number; outputTokens: number } | undefined
    if (!clean) {
      // The merge left conflicts in the working tree — have the agent resolve them.
      log.info('conflict: resolving conflicts with agent', trace)
      let stderrTail: string | undefined
      ;({ summary, stats, stderrTail, usage } = await runAgentInWorkspace(
        {
          dir,
          systemPrompt: job.systemPrompt,
          userPrompt: job.userPrompt,
          model: job.model,
          harness: job.harness,
          subscriptionToken: job.subscriptionToken,
          subscriptionBaseUrl: job.subscriptionBaseUrl,
          proxyBaseUrl: job.proxyBaseUrl,
          sessionToken: job.sessionToken,
        },
        opts,
      ))

      // Never push a half-resolved tree: if any conflict markers / unmerged paths
      // remain, the PR would still be broken. Fail so the engine can retry / notify.
      const unresolved = await unmergedPaths(dir, signal)
      if (unresolved.length > 0) {
        log.error('conflict: unresolved conflicts remain — refusing to push', {
          ...trace,
          unresolved: unresolved.length,
        })
        return {
          resolved: false,
          summary,
          stats,
          error: unresolvedReason(unresolved, stats, stderrTail),
          ...(usage ? { usage } : {}),
        }
      }
      // Complete the merge commit with the agent's resolution staged.
      await commitAll(dir, `Merge ${job.repo.baseBranch} into ${job.branch}`, signal)
    }

    // Whether base merged cleanly or the agent resolved it, push only if the branch
    // actually advanced (an already-up-to-date branch is a no-op we leave alone).
    if ((await headCommit(dir, signal)) === prTip) {
      log.info('conflict: branch already up to date with base — nothing to push', trace)
      return { resolved: true, summary, stats, ...(usage ? { usage } : {}) }
    }
    log.info('conflict: pushing resolved branch', { ...trace, ...stats })
    await pushBranch(dir, job.branch, job.ghToken, signal)
    return { resolved: true, summary, stats, ...(usage ? { usage } : {}) }
  })
}

/** Human-readable reason the agent failed to fully resolve the conflicts. */
function unresolvedReason(
  unresolved: string[],
  stats: PiRunStats,
  stderrTail: string | undefined,
): string {
  const cause = agentNeverActed(stats) ? NEVER_ACTED_CAUSE : ''
  const sample = unresolved.slice(0, 10).join(', ')
  return (
    `The agent did not resolve all merge conflicts ` +
    `(${unresolved.length} file(s) still conflicted: ${sample}).${cause}` +
    agentOutputTail(stderrTail)
  )
}
