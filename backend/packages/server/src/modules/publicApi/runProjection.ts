import type { Block, ExecutionInstance, PublicJob, PublicRun } from '@cat-factory/contracts'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { jobSortKey, mapStatus } from './publicApiPaging.js'
import { viewRunIdentity } from './runIdentityVisibility.js'

// The two RUN projections the public surface serves, plus the scoped load behind the job half.
//
// Extracted from `PublicApiController` because they have three consumers rather than one: the
// point reads in that controller, the two SSE loops in `publicApiStreamRoutes.ts`, and (through
// the stream) the decision channel. Keeping them there would have made the stream file import the
// controller that registers it.
//
// Both are PURE functions of the run plus the reading key's identity, which is what lets an SSE
// loop render frame after frame without a second read: see `runIdentityVisibility.ts` for why the
// reader is a parameter rather than something looked up in here.

/**
 * Project a persisted execution onto the external job resource (no block/board internals).
 *
 * Takes the READING key's own identity because the run's pinned one is not visible to every key
 * (`runIdentityVisibility.ts` holds the rule and why there is one). Passed as a parameter rather
 * than read off the context here, so the projection stays a pure function of the run plus the
 * caller and the SSE loops can render frame after frame without re-reading anything.
 */
export function toPublicJob(
  execution: ExecutionInstance,
  readerIdentity: string | null,
): PublicJob {
  const status = mapStatus(execution.status)
  const identity = viewRunIdentity(execution.initiatedByExternalIdentity, readerIdentity)
  // The deliverable is the LAST step that actually produced output, normally the terminal step,
  // but scanning from the end keeps the result meaningful for a multi-step public pipeline whose
  // final step is a side-effect-only tail that emits nothing (the built-in initiative pipeline is
  // single-step, so this simply picks that step). Fall back to the terminal step so a `succeeded`
  // run always carries a (possibly empty) result rather than null.
  const withOutput = [...execution.steps]
    .reverse()
    .find((s) => (s.output ?? '') !== '' || s.custom != null)
  const deliverable = withOutput ?? execution.steps[execution.steps.length - 1]
  const result =
    status === 'succeeded' && deliverable
      ? { output: deliverable.output ?? '', data: deliverable.custom ?? null }
      : null
  const error =
    status === 'failed'
      ? execution.failure
        ? { code: execution.failure.kind, message: execution.failure.message }
        : { code: 'run_failed', message: 'The run failed' }
      : null
  return {
    jobId: execution.id,
    status,
    pipelineId: execution.pipelineId,
    // Pinned at admission from the starting key, so it survives that key's revocation and costs
    // this projection no lookup (`toPublicJob` also renders every row of a paged list). Withheld
    // from a key that acts for someone else, which the flag STATES rather than blanking to a
    // `null` that already means "this run names nobody". Named field by field rather than spread,
    // for the reason `keyProjection.ts` gives: a spread is exempt from excess-property checking,
    // so a member added to the view type later would reach the wire with nothing to stop it.
    externalIdentity: identity.externalIdentity,
    externalIdentityWithheld: identity.externalIdentityWithheld,
    // The run's own creation stamp: the SAME value the list's keyset cursor is minted from
    // (`jobSortKey`), so a caller can page and correlate on one consistent number.
    createdAt: jobSortKey(execution),
    result,
    error,
  }
}

/**
 * Project a task's persisted run + its block onto the RICH external run resource: per-step
 * state/progress/subtasks, the failure kind+message, and the PR (url + branch). The run's
 * `status` is the raw execution status (`running`/`blocked`/`paused`/`done`/`failed`): the
 * public run view deliberately surfaces the parked states (unlike the coarse `publicJob`), so
 * a caller can tell an awaiting-a-human `blocked` from a still-`running` step. The PR branch
 * lives on the BLOCK (`block.pullRequest`), not the run, so both are joined here.
 */
export function toPublicRun(
  execution: ExecutionInstance,
  block: Block,
  readerIdentity: string | null,
): PublicRun {
  const pr = block.pullRequest
  const identity = viewRunIdentity(execution.initiatedByExternalIdentity, readerIdentity)
  return {
    runId: execution.id,
    taskId: block.id,
    status: execution.status,
    createdAt: jobSortKey(execution),
    currentStep: execution.currentStep,
    steps: execution.steps.map((s) => ({
      agentKind: s.agentKind,
      state: s.state,
      progress: s.progress,
      subtasks: s.subtasks
        ? {
            completed: s.subtasks.completed,
            inProgress: s.subtasks.inProgress,
            total: s.subtasks.total,
          }
        : null,
      // The step's deliverable. An EMPTY output is projected as null, matching the way
      // `toPublicJob` reads "produced something": a step that ran and wrote nothing and a step
      // that has not run yet are the same fact to a caller reading for a result, and the step's
      // own `state` is what distinguishes them.
      output: (s.output ?? '') === '' ? null : (s.output ?? null),
      data: s.custom ?? null,
      // Only when true: a step that RAN carries no flag at all, so the field never has to be read
      // as "false, and also this run is old enough to predate the projection".
      ...(s.skipped ? { skipped: true } : {}),
    })),
    // Who the run was started for, as pinned at admission; null for a run the app, a schedule or
    // an identity-less key started, and withheld (flagged, not blanked) from a key that acts for
    // someone else. See `runIdentityVisibility.ts`, and `toPublicJob` for why both members are
    // named rather than spread.
    externalIdentity: identity.externalIdentity,
    externalIdentityWithheld: identity.externalIdentityWithheld,
    pullRequest: pr ? { url: pr.url, branch: pr.branch ?? null } : null,
    error:
      execution.status === 'failed'
        ? execution.failure
          ? { code: execution.failure.kind, message: execution.failure.message }
          : { code: 'run_failed', message: 'The run failed' }
        : null,
  }
}

/**
 * Load a public JOB by id for an authenticated key: the persisted execution, but ONLY when it is
 * anchored on a HEADLESS internal block (a run this public surface created). Returns null when no
 * such run exists in the key's workspace OR the id points at a normal board execution, so an
 * external key can never read an arbitrary in-workspace run's output, only its own headless jobs.
 * Runtime-symmetric: one `executionRepository.get` + one `boardService.getInternalTask` point-read.
 */
export async function loadPublicJob<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  id: string,
): Promise<ExecutionInstance | null> {
  const container = c.get('container')
  const execution = await container.executionRepository.get(workspaceId, id)
  if (!execution) return null
  const anchor = await container.boardService.getInternalTask(workspaceId, execution.blockId)
  return anchor ? execution : null
}
