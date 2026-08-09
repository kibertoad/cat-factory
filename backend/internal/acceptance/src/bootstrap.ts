// Bootstrapping a repository, and waiting for it the way the board does.
//
// The wait is worth its own module because a bootstrap run fails in ways that look identical from
// a status field and need completely different fixes: no VCS credential, a repository name already
// taken, a container that never became healthy, a model that ran out of budget. The job carries a
// structured `failure` alongside the one-line `error` for exactly that reason, and this module's
// job is to make sure both reach the person rather than being flattened into "bootstrap failed".

import type { BootstrapJob, BootstrapRepoInput } from '@cat-factory/contracts'
import type { AppApi } from './appApi.ts'
import { waitFor } from './deadline.ts'
import type { Journal } from './journal.ts'

export type BootstrapOptions = {
  app: AppApi
  journal: Journal
  input: BootstrapRepoInput
  budgetMs: number
  /**
   * A job a previous pass started and did not see settle. Re-attached to rather than restarted,
   * because the repository name is taken the moment the FIRST job creates it: starting a second
   * one fails on a collision with its own predecessor, which reads like someone else's leftovers.
   */
  existingJobId: string | null
  /** Called with the job id as soon as one exists, so an interrupted pass can re-attach. */
  onStarted: (jobId: string) => void
}

/** Start a bootstrap (or re-attach to one) and wait for it to settle, succeeded or otherwise. */
export async function runBootstrap(options: BootstrapOptions): Promise<BootstrapJob> {
  const { app, journal, input, budgetMs, existingJobId } = options
  const jobId = existingJobId ?? (await start(options))
  if (existingJobId) {
    journal.say('milestone', `re-attaching to bootstrap ${existingJobId} for ${input.repoName}`)
  }
  return waitFor<BootstrapJob>({
    label: `the bootstrap of ${input.repoName}`,
    budgetMs,
    probe: async () => {
      const job = await app.getBootstrapJob(jobId)
      return job.status === 'succeeded' || job.status === 'failed'
        ? { done: true, value: job }
        : { done: false, state: describeBootstrap(job) }
    },
    onProgress: (state, elapsedMs) => {
      journal.say('observation', `[${Math.round(elapsedMs / 1000)}s] ${state}`)
    },
  })
}

async function start(options: BootstrapOptions): Promise<string> {
  const { app, journal, input, onStarted } = options
  const started = await app.startBootstrap(input)
  // Recorded before the first poll: the job creates a real repository, so a pass killed during
  // the wait must be able to find its way back to this job rather than trying the name again.
  onStarted(started.id)
  journal.say(
    'milestone',
    `bootstrap ${started.id} started for ${input.repoName} (block ${started.blockId})`,
  )
  return started.id
}

/** One line for the wait's progress and its expiry message. */
export function describeBootstrap(job: BootstrapJob): string {
  const progress = job.subtasks
    ? ` (${job.subtasks.completed}/${job.subtasks.total} subtasks, ${job.subtasks.inProgress} in progress)`
    : ''
  return `bootstrap ${job.id} status=${job.status}${progress}`
}

/**
 * Turn a failed bootstrap into a message that names the cause.
 *
 * Reads `failure.kind` as well as the prose: the kind is the platform's own classification of
 * whether a retry could possibly help (`preflight` cannot, `evicted` very likely can), which is
 * the first thing anyone re-running this suite needs to know and the one thing the one-line
 * `error` does not say.
 */
export function describeBootstrapFailure(job: BootstrapJob): string {
  const kind = job.failure?.kind ?? 'unknown'
  const detail = job.failure?.detail ? `\n  detail: ${job.failure.detail}` : ''
  // The platform's own "where to look next", carried through verbatim: it is written for this
  // exact moment, and re-deriving a hint here would just be a worse copy of it.
  const hint = job.failure?.hint ? `\n  hint: ${job.failure.hint}` : ''
  return (
    `Bootstrapping '${job.repoName}' failed (kind=${kind}): ${job.error ?? '(no message)'}${detail}${hint}\n` +
    `  The provisional board frame ${job.blockId ?? '(none)'} is left in place for inspection.`
  )
}

/**
 * Assert a bootstrap succeeded AND produced the two things later specs depend on.
 *
 * A `succeeded` job with no `blockId` or no repository would satisfy a status check and break
 * spec 02 much later, where the symptom is an unlinked service frame refusing to start a run.
 * Both are cheap to state here, next to the thing that produces them.
 */
export function requireBootstrapped(job: BootstrapJob): {
  blockId: string
  repoUrl: string | null
} {
  if (job.status !== 'succeeded') throw new Error(describeBootstrapFailure(job))
  if (!job.blockId) {
    throw new Error(
      `Bootstrapping '${job.repoName}' reported success but materialised no board frame, so ` +
        `nothing can be filed under it. This is a platform bug, not a setup problem.`,
    )
  }
  return { blockId: job.blockId, repoUrl: job.repoUrl }
}
