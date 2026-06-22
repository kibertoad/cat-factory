import type { FixerJob, FixerResult } from './job.js'
import { noChangesReason, runCodingAgent } from './coding-agent.js'
import type { RunOptions } from './runner.js'

// Async job execution for the test Fixer. When a Tester withholds its greenlight the
// engine dispatches this: clone the PR HEAD branch, run Pi to fix the concerns in the
// Tester's report (folded into the user prompt by the backend), then commit + push
// back onto the SAME branch (no new branch, no new PR) so the Tester can re-run. The
// engine re-dispatches the Tester after the push and loops up to the attempt budget.
//
// The clone/Pi/push mechanics are shared with implementation + the CI-fixer via
// runCodingAgent; the Fixer only differs in working ON the existing PR branch.

/** Run one Fixer job end to end: clone branch → Pi fixes → push (same branch). */
export async function handleFixer(job: FixerJob, opts: RunOptions = {}): Promise<FixerResult> {
  const { summary, stats, stderrTail, pushed, usage } = await runCodingAgent(
    {
      kind: 'fix-tests',
      jobId: job.jobId,
      repo: job.repo,
      // Work directly on the PR head branch — no new branch, no new PR.
      cloneBranch: job.branch,
      pushBranch: job.branch,
      ghToken: job.ghToken,
      systemPrompt: job.systemPrompt,
      userPrompt: job.userPrompt,
      model: job.model,
      harness: job.harness,
      subscriptionToken: job.subscriptionToken,
      subscriptionBaseUrl: job.subscriptionBaseUrl,
      proxyBaseUrl: job.proxyBaseUrl,
      sessionToken: job.sessionToken,
      commitMessage: 'Fix issues found by the tester',
      webToolsGuidance: job.webToolsGuidance,
      webSearchProxy: job.webSearch,
    },
    opts,
  )

  // Not an error: the engine re-runs the Tester regardless. Report `pushed: false`
  // so the (unused) result is still meaningful.
  if (!pushed) {
    return {
      pushed: false,
      summary,
      stats,
      error: noChangesReason('No test fix produced', stats, stderrTail),
      ...(usage ? { usage } : {}),
    }
  }
  return { pushed: true, summary, stats, ...(usage ? { usage } : {}) }
}
