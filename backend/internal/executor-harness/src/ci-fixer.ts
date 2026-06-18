import type { CiFixerJob, CiFixerResult } from './job.js'
import { noChangesReason, runCodingAgent } from './coding-agent.js'
import type { RunOptions } from './runner.js'

// Async job execution for the CI-fixer. When a PR's CI is red the engine
// dispatches this: clone the PR HEAD branch, run Pi to make the failing
// build/tests pass, then commit + push back onto the SAME branch (no new branch,
// no new PR) so CI re-runs. The engine re-polls CI after the push and loops the
// fixer up to the task's attempt budget. A run that produced no change pushes
// nothing and reports `pushed: false`.
//
// The clone/Pi/push mechanics are shared with implementation via runCodingAgent;
// the CI-fixer only differs in working ON the existing PR branch (no new branch /
// PR) and treating a no-op as non-fatal rather than an implementation failure.

/** Run one CI-fixer job end to end: clone branch → Pi fixes → push (same branch). */
export async function handleCiFixer(
  job: CiFixerJob,
  opts: RunOptions = {},
): Promise<CiFixerResult> {
  const { summary, stats, stderrTail, pushed } = await runCodingAgent(
    {
      kind: 'ci-fix',
      jobId: job.jobId,
      repo: job.repo,
      // Work directly on the PR head branch — no new branch, no new PR.
      cloneBranch: job.branch,
      pushBranch: job.branch,
      ghToken: job.ghToken,
      systemPrompt: job.systemPrompt,
      userPrompt: job.userPrompt,
      model: job.model,
      proxyBaseUrl: job.proxyBaseUrl,
      sessionToken: job.sessionToken,
      commitMessage: 'Fix failing CI',
    },
    opts,
  )

  // Not an error: the engine re-checks CI regardless and loops/exhausts. We report
  // `pushed: false` so the (unused) result is still meaningful.
  if (!pushed) {
    return {
      pushed: false,
      summary,
      stats,
      error: noChangesReason('No CI fix produced', stats, stderrTail),
    }
  }
  return { pushed: true, summary, stats }
}
