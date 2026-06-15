import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BootstrapJob, BootstrapResult } from './job.js'
import { cloneRepo, reinitAndPush } from './git.js'
import { runPi, writeAgentsContext, writePiModelsConfig } from './pi.js'

// Runs one repo-bootstrap job end to end: clone the reference architecture → the
// bootstrapper agent adapts it in place per the instructions → reset history to a
// single commit → push to the new repository. Mirrors handleRun's secret
// handling: the per-job GitHub + proxy tokens arrive in the request body and live
// only for the job's duration in an ephemeral workspace.

/** Run one bootstrap job end to end. */
export async function handleBootstrap(job: BootstrapJob): Promise<BootstrapResult> {
  const dir = await mkdtemp(join(tmpdir(), 'boot-'))
  try {
    await cloneRepo({
      repo: {
        owner: job.reference.owner,
        name: job.reference.name,
        baseBranch: job.reference.baseBranch,
        cloneUrl: job.reference.cloneUrl,
      },
      ghToken: job.ghToken,
      dir,
    })
    await writeAgentsContext(dir, job.systemPrompt)
    await writePiModelsConfig({ model: job.model, proxyBaseUrl: job.proxyBaseUrl })

    const summary = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: job.instructions,
      sessionToken: job.sessionToken,
    })

    await reinitAndPush({
      dir,
      target: job.target,
      ghToken: job.ghToken,
      message: `Bootstrap from ${job.reference.owner}/${job.reference.name}`,
    })
    return { defaultBranch: job.target.defaultBranch, summary }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
