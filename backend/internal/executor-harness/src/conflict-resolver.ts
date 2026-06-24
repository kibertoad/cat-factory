import type { ConflictResolverJob, ConflictResolverResult } from './job.js'
import {
  cloneRepo,
  commitAll,
  conflictDiff,
  headCommit,
  mergeBranch,
  pushBranch,
  unmergedPaths,
} from './git.js'
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

    // No conflicts to resolve. If base brought new commits the merge advanced the
    // branch, so push it; otherwise the branch is already up to date — a no-op we
    // leave alone (re-dispatching it never changes the PR, so a gate that keeps
    // seeing GitHub report this branch as "conflicting" is a base-resolution problem,
    // not the agent's — logged here so that loop is diagnosable).
    if (clean) {
      if ((await headCommit(dir, signal)) === prTip) {
        log.info('conflict: base merged clean and branch already up to date — nothing to push', {
          ...trace,
          base: job.repo.baseBranch,
        })
        return {
          resolved: true,
          summary: 'No conflicts: the branch is already up to date with its base.',
          stats: { toolCalls: 0, assistantChars: 0 },
        }
      }
      log.info('conflict: base merged clean — pushing the merge commit', trace)
      await pushBranch(dir, job.branch, job.ghToken, signal)
      return {
        resolved: true,
        summary: 'Merged the base in cleanly (no conflicts to resolve).',
        stats: { toolCalls: 0, assistantChars: 0 },
      }
    }

    // The merge left conflicts in the working tree. Surface the EXACT files + hunks
    // to the agent: the generic task prompt alone never told it which files conflict
    // (or even that there were conflicts), so it would drift onto the original feature
    // task. Lead with the conflict; keep the task only as trailing reference.
    const conflicted = await unmergedPaths(dir, signal)
    log.info('conflict: resolving conflicts with agent', { ...trace, conflicted })
    const diff = await conflictDiff(dir, conflicted, signal)
    const userPrompt = buildConflictPrompt(
      job.repo.baseBranch,
      job.branch,
      conflicted,
      diff,
      job.userPrompt,
    )

    const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt,
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
      },
      opts,
    )

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
    // Complete the merge commit with the agent's resolution staged, then push.
    await commitAll(dir, `Merge ${job.repo.baseBranch} into ${job.branch}`, signal)
    log.info('conflict: pushing resolved branch', { ...trace, ...stats })
    await pushBranch(dir, job.branch, job.ghToken, signal)
    return { resolved: true, summary, stats, ...(usage ? { usage } : {}) }
  })
}

/**
 * The conflict-focused user prompt: lead with the exact conflicted files and their
 * hunks (so the model acts on the real conflict, not the original feature task), then
 * carry the task only as trailing reference. The role/system prompt frames it as a
 * merge-conflict resolution; this gives it the concrete material.
 */
function buildConflictPrompt(
  baseBranch: string,
  prBranch: string,
  conflicted: string[],
  diff: string,
  taskReference: string,
): string {
  const fileList = conflicted.map((p) => `- ${p}`).join('\n')
  const parts = [
    `The base branch \`${baseBranch}\` was merged into this pull-request branch ` +
      `\`${prBranch}\` and left Git merge conflicts in the following ${conflicted.length} ` +
      `file(s):`,
    '',
    fileList,
    '',
    'Resolve EVERY conflict in these files: open each one, understand both sides of each ' +
      '`<<<<<<<` / `=======` / `>>>>>>>` region, and edit it to a correct result that ' +
      "preserves the intent of BOTH the base changes and this PR's changes — never just " +
      'discard one side. Remove every conflict marker and leave the project building. Do ' +
      'not create a new branch or PR; the harness completes the merge commit and pushes once ' +
      'no conflict markers remain.',
    '',
    'Conflict hunks (`git diff` of the conflicted files):',
    '',
    '```diff',
    diff,
    '```',
  ]
  const ref = taskReference.trim()
  if (ref) {
    parts.push('', 'For reference, the task this pull request implements:', '', ref)
  }
  return parts.join('\n')
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
