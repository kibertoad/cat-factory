import { readdir } from 'node:fs/promises'
import type { BootstrapJob, BootstrapResult } from './job.js'
import { cloneRepo, hasAgentChanges, reinitAndPush } from './git.js'
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

/**
 * Whether the bootstrapper actually produced repository content, so a no-op run
 * (the agent never reached the model / never wrote anything) is failed rather
 * than force-pushed as an empty repo. With a reference architecture, "produced
 * content" means the agent changed the clone; scaffolding from scratch, it means
 * at least one file now exists in the working directory. (The harness writes its
 * prompt context to Pi's global `~/.pi/agent/AGENTS.md`, never into `dir`, so
 * nothing here needs to be filtered out as harness boilerplate.)
 */
export async function producedRepoContent(
  dir: string,
  hasReference: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (hasReference) return hasAgentChanges(dir, signal)
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.some((entry) => entry.isFile())
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
  const cause = agentNeverActed(stats) ? NEVER_ACTED_CAUSE : ''
  return (
    `the bootstrapper agent ${what} ` +
    `(tool calls: ${stats.toolCalls}, assistant output: ${stats.assistantChars} chars).${cause}` +
    agentOutputTail(stderrTail, summary)
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
  const { signal } = opts
  // The worker keys the background job on `jobId`; thread it through every log
  // line so a bootstrap can be traced end to end in the Cloudflare dashboard.
  const trace = { jobId: job.jobId, target: `${job.target.owner}/${job.target.name}` }
  return withWorkspace('boot', async (dir) => {
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

    log.info('bootstrap: running agent', trace)
    const { summary, stats, stderrTail } = await runAgentInWorkspace(
      {
        dir,
        systemPrompt: job.systemPrompt,
        userPrompt: job.instructions,
        model: job.model,
        proxyBaseUrl: job.proxyBaseUrl,
        sessionToken: job.sessionToken,
      },
      opts,
    )

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
  })
}
