import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BootstrapJob, BootstrapResult } from './job.js'
import { cloneRepo, reinitAndPush } from './git.js'
import { runPi, writeAgentsContext, writePiModelsConfig } from './pi.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

// Runs one repo-bootstrap job end to end. With a reference architecture: clone it
// → the bootstrapper agent adapts it in place per the instructions. Without one:
// start from an empty directory → the agent scaffolds the new service from the
// instructions alone. Either way the result's history is reset to a single commit
// and pushed to the new repository. Mirrors handleRun's secret handling: the
// per-job GitHub + proxy tokens arrive in the request body and live only for the
// job's duration in an ephemeral workspace. Like /run it is driven as a background
// job: the `opts` carry the watchdog signal + the progress callback so the Worker
// can poll live "N/M done" subtask counts and surface them on the board.

/** Run one bootstrap job end to end. */
export async function handleBootstrap(
  job: BootstrapJob,
  opts: RunOptions = {},
): Promise<BootstrapResult> {
  const { signal, onActivity, onProgress } = opts
  const dir = await mkdtemp(join(tmpdir(), 'boot-'))
  // The worker keys the background job on `jobId`; thread it through every log
  // line so a bootstrap can be traced end to end in the Cloudflare dashboard.
  const trace = { jobId: job.jobId, target: `${job.target.owner}/${job.target.name}` }
  try {
    if (job.reference) {
      log.info('bootstrap: cloning reference architecture', {
        ...trace,
        reference: `${job.reference.owner}/${job.reference.name}`,
      })
      await cloneRepo({
        repo: {
          owner: job.reference.owner,
          name: job.reference.name,
          baseBranch: job.reference.baseBranch,
          cloneUrl: job.reference.cloneUrl,
        },
        ghToken: job.ghToken,
        dir,
        signal,
      })
    } else {
      log.info('bootstrap: scaffolding from scratch (no reference)', trace)
    }
    await writeAgentsContext(dir, job.systemPrompt)
    await writePiModelsConfig({ model: job.model, proxyBaseUrl: job.proxyBaseUrl })

    log.info('bootstrap: running agent', trace)
    const summary = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: job.instructions,
      sessionToken: job.sessionToken,
      signal,
      onActivity,
      onProgress,
    })

    log.info('bootstrap: force-pushing bootstrapped contents', trace)
    await reinitAndPush({
      dir,
      target: job.target,
      ghToken: job.ghToken,
      message: job.reference
        ? `Bootstrap from ${job.reference.owner}/${job.reference.name}`
        : 'Bootstrap new repository',
    })
    log.info('bootstrap: complete', { ...trace, defaultBranch: job.target.defaultBranch })
    return { defaultBranch: job.target.defaultBranch, summary }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
