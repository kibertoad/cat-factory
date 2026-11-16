import type { Block, PublicApiScope } from '@cat-factory/contracts'
import type { PublicApiKeyAuth } from '@cat-factory/integrations'
import { CredentialRequiredError, inputGateInputOf, type InputGateInput } from '@cat-factory/kernel'
import { scopeSatisfies } from '@cat-factory/integrations'
import { runnableShapeOf } from '@cat-factory/orchestration'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { keyInitiatorRole } from '../../http/runAdmission.js'
import {
  personalGateForBlock,
  personalGateForRun,
  type PersonalCredentialGate,
} from '../providers/personalCredentialGate.js'
import {
  individualModelUnsupported,
  personalUnlockFor,
  unlockIsUnavailable,
} from './personalUnlock.js'
import { startPipelineIdFor } from './pipelineSelection.js'
import {
  type AdmissiblePipelineShape,
  admissionRegistries,
  parkingRefusalMessage,
  publicRunParkSurfaces,
  PUBLIC_TASK_STOP_PATH,
} from './publicApiAdmission.js'

// Starting, stopping and retrying a board task's run for a public-API key: the admission rules
// both task resources share, a service task (`/api/v1/tasks/{taskId}`) and a project task
// (`/api/v1/projects/{projectId}/tasks/{taskId}`). Each returns the refusal to send, or undefined
// once the engine accepted the action; the caller re-reads the task for its own projection.

/** A refusal a task-run action answers with, which the route sends as its JSON error. */
export interface TaskRunRefusal {
  body: { error: { code: string; message: string } }
  status: 400 | 403 | 409
}

function refusal(body: TaskRunRefusal['body'], status: TaskRunRefusal['status']): TaskRunRefusal {
  return { body, status }
}

/**
 * The refusal message when a caller's scope cannot answer the parks a start would set in motion,
 * or `null` when there is nothing to refuse.
 *
 * Shared by every public start surface (`POST /jobs` and the task starts here) because the
 * rule is one rule: a pipeline that can park on a human needs a caller able to answer it, which is
 * exactly what the `decide` scope asserts, and a `write` key gets a refusal naming THIS run's park
 * surfaces (saying so, rather than promising an answer path that does not exist, for any the
 * decision surface cannot answer yet).
 *
 * `gateInput` is what makes it a RUN-level rather than a pipeline-level question: the pre-dispatch
 * input gate parks on the shape of the TASK, so a run under a pipeline that parks nowhere still
 * stops there. The jobs surface passes the shape of the anchor block it is about to create, since
 * the brief becomes that block's description and is exactly what the engine's own check reads a
 * moment later.
 */
export async function unanswerableParkRefusal(
  container: AppEnv['Variables']['container'],
  auth: { workspaceId: string; scope: PublicApiScope },
  pipeline: AdmissiblePipelineShape,
  gateInput: InputGateInput,
  cancelPath: string,
): Promise<string | null> {
  const surfaces = publicRunParkSurfaces(pipeline, admissionRegistries(container), {
    inputGateBlocks: await container.executionService.inputGateWouldBlock(
      auth.workspaceId,
      gateInput,
    ),
  })
  if (surfaces.length === 0 || scopeSatisfies(auth.scope, 'decide')) return null
  return parkingRefusalMessage(surfaces, { cancelPath })
}

/** Start a task's run, under the parking, personal-credential and engine start gates. */
export async function startTaskRun<E extends AppEnv>(
  c: Context<E>,
  auth: PublicApiKeyAuth,
  block: Block,
  requestedPipelineId: string | undefined,
): Promise<TaskRunRefusal | undefined> {
  const container = c.get('container')
  const taskId = block.id
  const pipelineId = await startPipelineIdFor(container, auth, {
    requested: requestedPipelineId,
    pinned: block.pipelineId,
  })
  if (!pipelineId) {
    return refusal(
      {
        error: {
          code: 'pipeline_required',
          message: 'This task has no pipeline; pass a pipelineId to start it',
        },
      },
      400,
    )
  }
  // The SAME parking rule as `POST /jobs`: a pipeline that can park the run on a human
  // decision (an approval gate on an enabled step, a review/brainstorm kind, or an
  // unbounded human-wait gate like `human-review`) needs a caller able to answer it, which
  // is what the `decide` scope asserts. This start path used to apply no pipeline admission
  // at all, so a plain `write` key (one deliberately NOT granted `decide`) could create
  // exactly the parked run the scope ladder says it must not oversee. Board runs stay
  // visible in the SPA, so a human can still answer them there; the rule is about what the
  // KEY may set in motion, not about recoverability.
  //
  // Resolved through the SAME question `ExecutionService.start` answers (`resolveForRun`), which
  // includes a catalog built-in this board has never adopted, so what is ADMITTED and what is RUN
  // cannot be two different definitions. Reading the stored row instead was a live hole rather
  // than a nicety: an un-adopted pipeline answered `null`, this check was skipped for want of
  // anything to inspect, and `start` then adopted and ran it, so a `write`-only key could park a
  // run after all. An id NOTHING defines still resolves to null and still fails inside `start`.
  const boardPipeline = await container.pipelineService.resolveForRun(auth.workspaceId, pipelineId)
  // Same rule as `POST /jobs` (see `unanswerableParkRefusal`), with THIS task's own input.
  const taskParkRefusal = boardPipeline
    ? await unanswerableParkRefusal(
        container,
        auth,
        boardPipeline,
        inputGateInputOf(block, container.taskTypeRegistry),
        PUBLIC_TASK_STOP_PATH,
      )
    : null
  if (taskParkRefusal) {
    return refusal(
      { error: { code: 'pipeline_requires_decide_scope', message: taskParkRefusal } },
      403,
    )
  }
  // A task whose model resolves to an individual-usage vendor (Claude / Codex) needs that
  // person's own subscription unlocked. An UNBOUND key has nobody to unlock for, so the gate
  // throws and the refusal below states the unsupported case; a key its holder bound to
  // themselves supplies both halves and the gate mints the run's activation like any other
  // start. A no-op either way for an ordinary poolable model, and passing no user means only
  // subscription-ONLY vendors gate (a dual-mode GLM task still runs on the poolable base).
  const unlock = personalUnlockFor(c, auth)
  let personal: PersonalCredentialGate
  try {
    personal = await personalGateForBlock(
      container,
      auth.workspaceId,
      taskId,
      pipelineId,
      unlock.user,
      unlock.password,
    )
  } catch (err) {
    if (err instanceof CredentialRequiredError && unlockIsUnavailable(unlock)) {
      return refusal({ error: individualModelUnsupported('task') }, 409)
    }
    // A bound key CAN answer this: let the 428 through with its vendor + reason so the caller
    // knows to prompt for (or correct) the password rather than treating it as unsupported.
    throw err
  }
  // The engine's own start-time gates (per-service running-task cap, dependency gate,
  // runnability) apply as for any board start; their `DomainError`s map to the right HTTP status
  // via the shared error handler. This is the abuse backstop for board starts, the analogue of
  // the jobs surface's active-run cap.
  await container.executionService.start(auth.workspaceId, taskId, pipelineId, {
    // The bound user, or `null` for an unbound key (headless / system-initiated, as before).
    initiatedBy: personal.initiatedBy,
    // And the tier that user holds on this board, so a bound key's run is admitted under the
    // same merge policy, submission allow-list and dry-run sandbox its holder gets in the app.
    // See `keyInitiatorRole`: an initiator with no role is a run with no policy, not a lenient
    // one.
    initiatedByRole: await keyInitiatorRole(container, auth.workspaceId, personal.initiatedBy),
    // As on the jobs surface: the key can still name who it started this for, and it does so
    // whether or not a user is bound; the two answer different questions (a `usr_*` account
    // here, an identity only the caller's own side can resolve there).
    initiatedByExternalIdentity: auth.externalIdentity,
    intakeOrigin: 'public-api',
    activate: personal.activate,
  })
  return undefined
}

/** Stop a task's in-flight run, recording a `cancelled` terminal state that stays retryable. */
export async function stopTaskRun<E extends AppEnv>(
  c: Context<E>,
  auth: PublicApiKeyAuth,
  taskId: string,
): Promise<TaskRunRefusal | undefined> {
  const container = c.get('container')
  const run = await container.executionRepository.getByBlock(auth.workspaceId, taskId)
  if (!run) {
    return refusal({ error: { code: 'no_run', message: 'Task has no run to stop' } }, 409)
  }
  await container.executionService.stopRun(auth.workspaceId, run.id)
  return undefined
}

/** Retry a task's failed run, under the same parking and personal-credential gates as a start. */
export async function retryTaskRun<E extends AppEnv>(
  c: Context<E>,
  auth: PublicApiKeyAuth,
  block: Block,
): Promise<TaskRunRefusal | undefined> {
  const container = c.get('container')
  const taskId = block.id
  const run = await container.executionRepository.getByBlock(auth.workspaceId, taskId)
  if (!run) {
    return refusal({ error: { code: 'no_run', message: 'Task has no run to retry' } }, 409)
  }
  // The SAME parking rule as the two start paths, asked of the run's STORED steps because that
  // is what a retry re-drives (`runnableShapeOf`, the engine's own answer to the same question).
  // A start path is not the only way to set a park in motion: a `write` key holding a task whose
  // review run failed could re-drive it and be holding a parked run again a moment later, which
  // is the capability the scope ladder says it does not have. The stored steps are also the
  // honest subject here: an out-of-band pipeline edit since the run started changes nothing
  // about what re-executes.
  //
  // The input gate is asked about unconditionally: a resumed instance carries no verdict
  // forward, so a retry that resumes at step 0 re-evaluates it. That over-counts only for a
  // retry resuming LATER whose task inputs are still thin, which is the safe direction and the
  // same one the interview-gate check takes.
  const retryParkRefusal = await unanswerableParkRefusal(
    container,
    auth,
    runnableShapeOf(run.steps),
    inputGateInputOf(block, container.taskTypeRegistry),
    PUBLIC_TASK_STOP_PATH,
  )
  if (retryParkRefusal) {
    return refusal(
      { error: { code: 'pipeline_requires_decide_scope', message: retryParkRefusal } },
      403,
    )
  }
  const unlock = personalUnlockFor(c, auth)
  let personal: PersonalCredentialGate
  try {
    personal = await personalGateForRun(
      container,
      auth.workspaceId,
      run.id,
      unlock.user,
      unlock.password,
    )
  } catch (err) {
    if (err instanceof CredentialRequiredError && unlockIsUnavailable(unlock)) {
      return refusal({ error: individualModelUnsupported('task') }, 409)
    }
    throw err
  }
  // A non-failed run is rejected inside `retry` with `run_not_retryable` → 409 via the shared
  // error handler. The retry re-drives the STORED steps, so the activation the gate minted (if
  // any) is the one those steps will lease.
  //
  // No role is pinned here, and that asymmetry with `startTaskRun` above is the engine's rule
  // rather than an omission. A bound key that retries someone else's failed run BECOMES its
  // initiator, because only the person present can unlock their own subscription. But the
  // ADMISSION authority does not move with them: `buildResumedInstance` carries the pinned role
  // and mode forward from the run being replaced, so a re-drive stays the same work under the
  // authority it was originally granted. Re-resolving it for whoever drove the retry is what
  // would be wrong (a sweeper drives one with no user at all), and dropping it is the escape
  // hatch that comment names: restart-from-step-0 would launder a dry run into a live one. The
  // SPA's retry path (`AgentRunController`) has exactly this shape, for exactly this reason.
  await container.executionService.retry(
    auth.workspaceId,
    run.id,
    personal.initiatedBy,
    personal.activate,
  )
  return undefined
}
