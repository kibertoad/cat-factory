import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import type { ExploreJob, ExploreResult } from './job.js'
import { cloneRepo } from './git.js'
import type { PiRunStats } from './pi.js'
import {
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

// The shared read-only container agent: clone a branch, run Pi to EXPLORE the
// checkout (read-only), and return its prose report/proposal. Both the architect
// (proposes a design after reading the code) and the tech-debt analysis agent use
// this one path. Unlike the coding agents (`/run`, `/ci-fix`) it pushes nothing and
// opens no PR, and — like the merger — it makes no edits, so an edit-free run is the
// expected, correct outcome rather than a "no changes" failure. The only failure
// mode is producing no text at all (the agent never reached the model).

/** Run one read-only exploration job end to end: clone branch → Pi explores → return prose. */
export async function handleExplore(
  job: ExploreJob,
  opts: RunOptions = {},
): Promise<ExploreResult> {
  const trace = {
    jobId: job.jobId,
    kind: job.label ?? 'explore',
    repo: `${job.repo.owner}/${job.repo.name}`,
    branch: job.branch,
  }
  return withWorkspace(job.label ?? 'explore', async (dir) => {
    log.info('explore: cloning', trace)
    await cloneRepo({
      repo: { ...job.repo, baseBranch: job.branch },
      ghToken: job.ghToken,
      dir,
      signal: opts.signal,
    })

    // In a monorepo the service lives in a subdirectory: run Pi with its cwd set
    // there (created if missing, mirroring the coding agent) so a service-scoped
    // exploration sees the right subtree.
    const serviceDirectory = job.repo.serviceDirectory
    const workDir = serviceDirectory ? join(dir, serviceDirectory) : dir
    if (serviceDirectory) await mkdir(workDir, { recursive: true })

    log.info('explore: running agent', { ...trace, serviceDirectory })
    const { summary, stats, stderrTail, usage } = await runAgentInWorkspace(
      {
        dir: workDir,
        systemPrompt: job.systemPrompt,
        userPrompt: job.userPrompt,
        model: job.model,
        harness: job.harness,
        subscriptionToken: job.subscriptionToken,
        subscriptionBaseUrl: job.subscriptionBaseUrl,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
        serviceDirectory,
        // Read-only: it inspects and reports, making no edits — so the no-progress
        // guard's no-edit bound must not fire on its legitimately edit-free run.
        expectsEdits: false,
        webToolsGuidance: job.webToolsGuidance,
        webSearchProxy: job.webSearch,
      },
      opts,
    )

    // The prose report IS the deliverable; an edit-free run is success. The only
    // failure is producing no text at all (the signature of never reaching the model).
    if (!summary.trim()) {
      return {
        summary,
        stats,
        error: noOutputReason(stats, stderrTail),
        ...(usage ? { usage } : {}),
      }
    }
    log.info('explore: done', { ...trace, ...stats })
    return { summary, stats, ...(usage ? { usage } : {}) }
  })
}

/** Human-readable reason a read-only run produced no usable output. */
function noOutputReason(stats: PiRunStats, stderrTail: string | undefined): string {
  const cause = agentNeverActed(stats)
    ? ' (the agent never acted — it most likely could not reach the model)'
    : ''
  return `Read-only agent produced no report${cause}.${agentOutputTail(stderrTail)}`
}
