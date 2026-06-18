import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CiFixerJob, CiFixerResult } from './job.js'
import { cloneRepo, commitAll, pushBranch } from './git.js'
import { runPi, writeAgentsContext, writePiModelsConfig } from './pi.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

// Async job execution for the CI-fixer. When a PR's CI is red the engine
// dispatches this: clone the PR HEAD branch, run Pi to make the failing
// build/tests pass, then commit + push back onto the SAME branch (no new branch,
// no new PR) so CI re-runs. The engine re-polls CI after the push and loops the
// fixer up to the task's attempt budget. A run that produced no change pushes
// nothing and reports `pushed: false`.

/** Run one CI-fixer job end to end: clone branch → Pi fixes → commit → push. */
export async function handleCiFixer(job: CiFixerJob, opts: RunOptions = {}): Promise<CiFixerResult> {
  const { signal, onActivity, onProgress } = opts
  const dir = await mkdtemp(join(tmpdir(), 'ci-fix-'))
  const trace = { jobId: job.jobId, repo: `${job.repo.owner}/${job.repo.name}`, branch: job.branch }
  try {
    log.info('ci-fix: cloning PR branch', trace)
    // Clone the PR head branch directly (no new branch) so fixes land on it.
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal,
    })
    await writeAgentsContext(dir, job.systemPrompt)
    await writePiModelsConfig({ model: job.model, proxyBaseUrl: job.proxyBaseUrl })

    log.info('ci-fix: running agent', trace)
    const { summary, stats, stderrTail } = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: job.userPrompt,
      sessionToken: job.sessionToken,
      signal,
      onActivity,
      onProgress,
    })

    const committed = await commitAll(dir, 'Fix failing CI', signal)
    if (!committed) {
      const cause =
        stats.toolCalls === 0 && stats.assistantChars === 0
          ? ' (the agent never acted — it most likely could not reach the model)'
          : ''
      const detail = stderrTail ? ` Agent stderr: ${stderrTail.slice(-700)}` : ''
      // Not an error: the engine re-checks CI regardless and loops/exhausts. We
      // report `pushed: false` so the (unused) result is still meaningful.
      log.info('ci-fix: no changes to push', trace)
      return { pushed: false, summary, stats, error: `No CI fix produced${cause}.${detail}` }
    }
    log.info('ci-fix: pushing fix', { ...trace, ...stats })
    await pushBranch(dir, job.branch, job.ghToken, signal)
    return { pushed: true, summary, stats }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
