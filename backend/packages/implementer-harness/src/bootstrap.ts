import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BootstrapJob, BootstrapResult } from './job.js'
import { cloneRepo, hasAgentChanges, reinitAndPush } from './git.js'
import { type PiRunStats, runPi, writeAgentsContext, writePiModelsConfig } from './pi.js'
import type { RunOptions } from './runner.js'
import { log } from './logger.js'

/**
 * Whether the bootstrapper actually produced repository content, so a no-op run
 * (the agent never reached the model / never wrote anything) is failed rather
 * than force-pushed as an empty repo. With a reference architecture, "produced
 * content" means the agent changed the clone (beyond the harness's AGENTS.md);
 * scaffolding from scratch, it means at least one file other than AGENTS.md now
 * exists in the working directory.
 */
export async function producedRepoContent(
  dir: string,
  hasReference: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (hasReference) return hasAgentChanges(dir, signal)
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase() !== 'agents.md')
}

/** Human-readable no-op reason, embedding what the agent did so the cause is visible. */
function noOpReason(
  hasReference: boolean,
  stats: PiRunStats,
  summary: string,
  stderrTail: string | undefined,
): string {
  const what = hasReference
    ? 'made no changes to the reference architecture'
    : 'scaffolded no files'
  const acted = stats.toolCalls === 0 && stats.assistantChars === 0
  const cause = acted
    ? ' The agent never acted (no tool calls, no model output) — it most likely could not reach the model.'
    : ''
  // Pi's stderr carries the real failure (unreachable proxy, rejected model, …);
  // the stdout summary is the fallback when stderr is empty.
  const detail = stderrTail
    ? ` Agent stderr: ${stderrTail.slice(-700)}`
    : summary
      ? ` Agent output: ${summary.slice(0, 700)}`
      : ''
  return (
    `the bootstrapper agent ${what} ` +
    `(tool calls: ${stats.toolCalls}, assistant output: ${stats.assistantChars} chars).${cause}${detail}`
  )
}

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
    const { summary, stats, stderrTail } = await runPi({
      cwd: dir,
      model: job.model,
      userPrompt: job.instructions,
      sessionToken: job.sessionToken,
      signal,
      onActivity,
      onProgress,
    })

    // Guard against a no-op run: Pi can exit cleanly having done nothing (e.g. it
    // never reached the model), and reinitAndPush would then force-push an empty
    // tree — leaving the run "succeeded" but the repo bare. Fail with a structured
    // error (carrying what the agent did) instead of pushing nothing.
    if (!(await producedRepoContent(dir, !!job.reference, signal))) {
      const error = noOpReason(!!job.reference, stats, summary, stderrTail)
      log.error('bootstrap: agent produced no content — refusing to push', { ...trace, ...stats })
      return { summary, stats, error }
    }

    log.info('bootstrap: force-pushing bootstrapped contents', { ...trace, ...stats })
    await reinitAndPush({
      dir,
      target: job.target,
      ghToken: job.ghToken,
      message: job.reference
        ? `Bootstrap from ${job.reference.owner}/${job.reference.name}`
        : 'Bootstrap new repository',
    })
    log.info('bootstrap: complete', { ...trace, defaultBranch: job.target.defaultBranch })
    return { defaultBranch: job.target.defaultBranch, summary, stats }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
