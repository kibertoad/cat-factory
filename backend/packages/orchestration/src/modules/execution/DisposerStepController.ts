import type {
  AgentRunResult,
  Block,
  ExecutionInstance,
  Logger,
  PipelineStep,
} from '@cat-factory/kernel'
import { getErrorMessage, noopLogger } from '@cat-factory/kernel'
import { DEPLOYER_AGENT_KIND } from '@cat-factory/integrations'
import type {
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
} from '@cat-factory/integrations'
import type { RunStateMachine } from './RunStateMachine.js'
import type { AdvanceResult } from './advance.js'

// ---------------------------------------------------------------------------
// The deterministic `disposer` step: the `deployer`'s counterpart at the other end of the
// environment lifecycle. No LLM and no token usage — it reclaims the environments THIS RUN
// stood up, at the point in the pipeline its author chose.
//
// Why a step at all, when a TTL reaper already exists: the reaper fires on a timer, long after
// the run settled. That makes it a fine BACKSTOP and a useless PROOF. A run's PR carries an
// "environment up → evidence captured → torn down" section, and the third leg of it can only be
// closed while something is still watching; left to the sweep, the PR is published saying the
// environment is still live and is corrected minutes-to-hours later, if the deployment retains a
// provisioning log at all. A disposer closes the proof inside the run, and lets an author decide
// WHEN — after the automated tester, or after a human has finished poking at the environment.
//
// Two rules shape it:
//
//  - **It reclaims what the RUN provisioned, by identity.** The frames come from the deployer
//    step's own recorded `deployEnvs`, never from a fresh frame-set resolution. That set is the
//    exact list of environments this run stood up, so a mid-run connection edit cannot widen the
//    disposer onto a peer it never deployed, nor narrow it off one it did — and re-deriving the
//    frames would be a second answer to a question the deployer already answered and persisted.
//
//  - **It is BEST-EFFORT and never fails the run.** A disposer usually runs after `merger`, so
//    a teardown hiccup must not flip a shipped, merged pipeline to failed: the work is done and
//    the PR is in. Every failure is recorded on the step (and in the provisioning log) and the
//    TTL reaper remains the backstop. This is the opposite disposition from the deployer, whose
//    primary-frame failure IS terminal — provisioning is a prerequisite, disposal is cleanup.
// ---------------------------------------------------------------------------

/** Per-frame reclaim outcome, as recorded on `step.disposeEnvs`. */
type DisposeEnvState = NonNullable<PipelineStep['disposeEnvs']>[string]

export interface DisposerStepControllerDeps {
  runStateMachine: RunStateMachine
  /** Resolves each frame's live environment handle. Absent ⇒ the step is a pass-through. */
  environmentProvisioning?: EnvironmentProvisioningService
  /** Performs (and confirms) the teardown. Absent ⇒ the step is a pass-through. */
  environmentTeardown?: EnvironmentTeardownService
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
  /**
   * Where a teardown failure is reported. The step records it too, but a run's step state is
   * read by whoever opens that run, and an environment nobody reclaimed is an operator's
   * problem before it is that reader's. Absent ⇒ `noopLogger`.
   */
  logger?: Logger
}

/**
 * The service frames this run stood environments up for, read off the deployer step's recorded
 * per-frame outcomes. Only `ready` frames are candidates: a `failed` frame never got an
 * environment and a `skipped` one was never meant to have one, so neither is something to
 * reclaim — and reporting either as "nothing to tear down" would pad the disposer's summary with
 * frames it did no work for.
 *
 * Reads EVERY deployer step rather than the first, because a pipeline may deploy more than once
 * (a re-deploy after a fix), and a disposer that reclaimed only the first one's frames would
 * leave the rest standing while reporting a clean sweep.
 */
function provisionedFrameIds(instance: ExecutionInstance): string[] {
  const frameIds = new Set<string>()
  for (const step of instance.steps) {
    if (step.agentKind !== DEPLOYER_AGENT_KIND) continue
    for (const [frameId, env] of Object.entries(step.deployEnvs ?? {})) {
      if (env.status === 'ready') frameIds.add(frameId)
    }
  }
  return [...frameIds]
}

/** The one-line summary of a frame's reclaim, for the step's output. */
function describeOutcome(frameId: string, state: DisposeEnvState): string {
  switch (state.status) {
    case 'reclaimed':
      return state.confirmation === 'confirmed'
        ? `Reclaimed the environment for frame '${frameId}' (confirmed gone).`
        : // NOT rendered as a clean reclaim: the whole point of the confirmation is that a
          // teardown call returning is not the environment being gone.
          `Tore down the environment for frame '${frameId}', but could not confirm it is gone (${state.confirmation}): ${state.error ?? 'no reason given'}`
    case 'failed':
      return `Could not tear down the environment for frame '${frameId}': ${state.error ?? 'unknown error'}. It is still standing; the TTL sweep will retry.`
    case 'none':
      return `No live environment was found for frame '${frameId}'; nothing to reclaim.`
  }
}

export class DisposerStepController {
  private readonly log: Logger

  constructor(private readonly deps: DisposerStepControllerDeps) {
    this.log = (deps.logger ?? noopLogger).child({ scope: 'disposerStep' })
  }

  /**
   * Reclaim every environment this run provisioned, then complete the step.
   *
   * Each frame's outcome is persisted BEFORE the next is attempted, so a crash or a durable
   * replay resumes at the first un-settled frame instead of re-tearing down an environment that
   * is already gone (the same rule the deployer's fan-out follows, and for the same reason: the
   * teardown call is not idempotency-guarded by a job ref).
   */
  async runDisposerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    _block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const frameIds = provisionedFrameIds(instance)
    if (frameIds.length === 0) {
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: 'No environment was provisioned by this run, so there was nothing to reclaim.',
        model: 'environment:none',
      })
    }
    for (const frameId of frameIds) {
      if (step.disposeEnvs?.[frameId]) continue
      const state = await this.reclaimFrame(workspaceId, instance, frameId)
      step.disposeEnvs = { ...step.disposeEnvs, [frameId]: state }
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
    }
    return this.completeDisposerStep(workspaceId, instance, step, isFinalStep)
  }

  /**
   * Tear down one frame's environment, never throwing: a reclaim failure is DATA the step
   * records, not a run failure (see the header). The distinction between "the provider refused"
   * (`failed`) and "the provider accepted and we could not prove it worked" (`reclaimed` with a
   * non-`confirmed` confirmation) is preserved all the way onto the step, because they need
   * different people to do different things.
   */
  private async reclaimFrame(
    workspaceId: string,
    instance: ExecutionInstance,
    frameId: string,
  ): Promise<DisposeEnvState> {
    const provisioning = this.deps.environmentProvisioning
    const teardown = this.deps.environmentTeardown
    // Unwired is a pass-through, byte-for-byte the prior behaviour: a deployment with no
    // environment integration never provisioned anything to reclaim either.
    if (!provisioning || !teardown) {
      return { status: 'none' }
    }
    const handle = await provisioning
      .getHandleForBlock(workspaceId, instance.blockId, frameId)
      .catch(() => null)
    // The registry has no live row for this frame. Something already reclaimed it (a supersede,
    // an operator's Destroy, the TTL sweep on a long run), which is a legitimate outcome and not
    // a failure — but it is recorded as `none` rather than as a reclaim, because this step did
    // not observe the environment going away and must not claim credit for it.
    if (!handle) return { status: 'none' }
    try {
      const result = await teardown.teardown(workspaceId, handle.id)
      return {
        status: 'reclaimed',
        environmentId: handle.id,
        confirmation: result.confirmation,
        error: result.reason,
      }
    } catch (error) {
      const message = getErrorMessage(error)
      // Logged as well as recorded: an environment the provider refused to reclaim is billed
      // infrastructure nobody is watching, and the run's own step state is only seen by whoever
      // opens that run.
      this.log.warn('Environment teardown failed during a disposer step', {
        workspaceId,
        executionId: instance.id,
        frameId,
        environmentId: handle.id,
        error: message,
      })
      return { status: 'failed', environmentId: handle.id, error: message }
    }
  }

  /**
   * Complete the step with a per-frame summary.
   *
   * The step always SUCCEEDS (see the header), so the summary is where an unreclaimed or
   * unconfirmed environment is stated — and it is stated explicitly rather than left as an
   * absence, because a disposer whose output said nothing about a frame reads exactly like one
   * that reclaimed it cleanly.
   */
  private async completeDisposerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const entries = Object.entries(step.disposeEnvs ?? {})
    const confirmed = entries.filter(
      ([, s]) => s.status === 'reclaimed' && s.confirmation === 'confirmed',
    ).length
    const lines = entries.map(([frameId, state]) => describeOutcome(frameId, state))
    return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
      output: lines.join('\n'),
      model: `environment:disposed-${confirmed}/${entries.length}`,
    })
  }
}
