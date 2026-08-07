import { opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentJob, AgentResult } from './job.js'
import type { PiRunStats } from './pi.js'
import type { RunOptions } from './runner.js'
import {
  NEVER_ACTED_CAUSE,
  agentNeverActed,
  agentOutputTail,
  runAgentInWorkspace,
  withWorkspace,
} from './pi-workspace.js'
import { cloneRepo, hasAgentChanges, reinitAndPush } from './git.js'
import { log } from './logger.js'
import { agentCapabilities, mergeEffort } from './agent-shared.js'

// ---------------------------------------------------------------------------
// The repo-BOOTSTRAP mode: adapt a reference architecture (or scaffold from scratch) into a
// pre-created empty repo and force-push it as a single commit. Extracted from `agent.ts` as a
// cohesive collaborator — it is a whole MODE with its own push semantics (a separate target repo
// and a reinitialised history, not a work branch + PR), and it shares only the small agent-run
// helpers in `agent-shared.ts` with the coding/explore flows.
// ---------------------------------------------------------------------------

/**
 * Repo-bootstrap coding flow (the bootstrapper): with a reference architecture, clone it →
 * the agent adapts it in place per the instructions; without one (`fromScratch`), start from
 * an empty directory → the agent scaffolds the new service. Either way the result's history
 * is reset to a single commit and force-pushed to the SEPARATE, pre-created target repo's
 * default branch. Diverges from the ordinary coding flow in pushing to a different repo with
 * a reinitialised history rather than a work branch + PR on the cloned repo.
 */
export async function runBootstrap(job: AgentJob, opts: RunOptions): Promise<AgentResult> {
  const { signal } = opts
  const boot = job.bootstrap!
  const fromScratch = boot.fromScratch === true
  const logger = (opts.log ?? log).child({ target: `${boot.target.owner}/${boot.target.name}` })
  return withWorkspace('boot', async (dir) => {
    if (!fromScratch) {
      opts.onPhase?.('clone')
      logger.info('agent(bootstrap): cloning reference architecture', {
        reference: `${job.repo.owner}/${job.repo.name}`,
      })
      await cloneRepo({
        repo: { ...job.repo, baseBranch: job.branch },
        ghToken: job.ghToken,
        dir,
        signal,
      })
    } else {
      logger.info('agent(bootstrap): scaffolding from scratch (no reference)')
    }

    opts.onPhase?.('agent')
    logger.info('agent(bootstrap): running agent')
    const { summary, stats, stderrTail, usage, callMetrics, effortReport } =
      await runAgentInWorkspace(
        {
          dir,
          systemPrompt: job.systemPrompt,
          userPrompt: job.userPrompt,
          model: job.model,
          harness: job.harness,
          subscriptionToken: job.subscriptionToken,
          subscriptionBaseUrl: job.subscriptionBaseUrl,
          ambientAuth: job.ambientAuth,
          proxyBaseUrl: job.proxyBaseUrl,
          proxyPhasePath: job.proxyPhasePath,
          sessionToken: job.sessionToken,
          guardLimits: job.guardLimits,
          ...agentCapabilities(job),
        },
        opts,
      )

    // Guard against a no-op run: Pi can exit cleanly having done nothing (e.g. it never
    // reached the model), and a force-push would then publish an empty tree — leaving the
    // run "succeeded" but the repo bare. Fail with a structured error (carrying what the
    // agent did) instead of pushing nothing.
    if (!(await producedRepoContent(dir, !fromScratch, signal))) {
      const error = bootstrapNoOpReason(!fromScratch, stats, summary, stderrTail)
      logger.error('agent(bootstrap): agent produced no content, refusing to push', { ...stats })
      return mergeEffort(
        {
          summary,
          stats,
          error,
          failureCause: 'agent',
          ...(usage ? { usage } : {}),
          ...(callMetrics ? { callMetrics } : {}),
        },
        effortReport,
      )
    }

    opts.onPhase?.('push')
    logger.info('agent(bootstrap): pushing bootstrapped contents', { ...stats })
    // Bootstrap always resets history to one commit + force-pushes (the fresh history
    // shares no ancestor with whatever boilerplate the new repo was created with).
    await reinitAndPush({
      dir,
      target: boot.target,
      ghToken: job.ghToken,
      signal,
      message: fromScratch
        ? 'Bootstrap new repository'
        : `Bootstrap from ${job.repo.owner}/${job.repo.name}`,
    })
    logger.info('agent(bootstrap): complete', { defaultBranch: boot.target.defaultBranch })
    return mergeEffort(
      {
        defaultBranch: boot.target.defaultBranch,
        summary,
        stats,
        ...(usage ? { usage } : {}),
        ...(callMetrics ? { callMetrics } : {}),
      },
      effortReport,
    )
  })
}

/**
 * Whether the bootstrapper actually produced repository content, so a no-op run (the agent
 * never reached the model / never wrote anything) is failed rather than force-pushed as an
 * empty repo. With a reference architecture, "produced content" means the agent changed the
 * clone; scaffolding from scratch, it means at least one file now exists in the working
 * directory. (The harness writes its prompt context to Pi's global `~/.pi/agent/AGENTS.md`,
 * never into `dir`, so nothing here needs to be filtered out as harness boilerplate.)
 */
export async function producedRepoContent(
  dir: string,
  hasReference: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (hasReference) return hasAgentChanges(dir, signal)
  return containsAnyFile(dir)
}

/**
 * Whether `dir` contains at least one regular file anywhere in its tree, walking
 * depth-first and stopping at the FIRST file found — so the cost is bounded by how
 * quickly a file turns up (a scaffold almost always writes a root-level file), not by
 * the size of the produced tree (a full recursive `readdir` would materialise every
 * entry before the check).
 */
async function containsAnyFile(dir: string): Promise<boolean> {
  const handle = await opendir(dir)
  try {
    for await (const entry of handle) {
      if (entry.isFile()) return true
      if (entry.isDirectory() && (await containsAnyFile(join(dir, entry.name)))) return true
    }
  } catch {
    // A directory that vanished mid-walk has nothing to contribute.
  }
  return false
}

/** Human-readable bootstrap no-op reason, embedding what the agent did so the cause is visible. */
function bootstrapNoOpReason(
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
