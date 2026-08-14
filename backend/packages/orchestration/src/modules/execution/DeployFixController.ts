import type {
  AgentExecutor,
  AgentJobUpdate,
  AgentRunContext,
  Block,
  Clock,
  DeployFixAttempt,
  ExecutionInstance,
  Logger,
  PipelineStep,
  ServiceProvisioning,
} from '@cat-factory/kernel'
import { isAsyncAgentExecutor, noopLogger, runBestEffort } from '@cat-factory/kernel'
import {
  DEFAULT_DEPLOY_FIX_MAX_ATTEMPTS,
  DEPLOY_FIXER_AGENT_KIND,
  isRepoFixableEnvironmentFailure,
} from '@cat-factory/contracts'
import { DEPLOY_FAILURE_PRIOR_KIND } from '@cat-factory/agents'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { recordDispatchAttribution } from './step-fold.logic.js'

// ---------------------------------------------------------------------------
// The `deployer`'s REMEDIATION loop: when a provision fails on the task's own service frame for a
// cause the platform has classified as fixable IN THE CHECKOUT, escalate to the `deploy-fixer`
// container agent and re-provision against its push, bounded.
//
// Extracted as a collaborator rather than grown onto `DeployerStepController` (the file-size rule:
// split along a seam, never raise the ratchet), the same shape the deployer itself was extracted
// from `RunDispatcher` in.
//
// WHY THE DEPLOYER OWNS THIS, and not a gate after it. The deployer already owns provisioning
// through to a terminal verdict (`pollDeployerJob` → `settleDeployerFrame` resolves the handle), so
// a gate whose probe read the environment status would re-read what the deployer had just written.
// The gate shape is only correct if checking the deployment OUTCOME is not the deployer's
// responsibility, and it is. It is also not a new `evaluateX`/`pollX`/`awaiting_x` triple: the
// deployer already has its own poll path and `awaiting_job` park, and this rides both.
//
// WHAT MAKES THIS A REPAIR RATHER THAN A GUESS. The loop refuses to run unless the failure is
// classified `manifest_invalid` (`isRepoFixableEnvironmentFailure`). That precondition is the
// whole feature. The motivating run (`exec_194b231198454c7785f29589`) failed with a Deployment
// rejected for a missing `image` where the manifest correctly said `image: "{{image}}"` and the
// workspace connection carried no `imageTemplate`; an agent handed that failure and a checkout has
// exactly one move, which is to hard-code an image, turning the run green while permanently
// defeating per-PR substitution and hiding the unwired connection the failure was reporting. A
// prompt asking it not to is not a mechanism. Classification is.
//
// AND THE PROOF IS THE RE-PROVISION. The fixer is never asked whether it succeeded and carries no
// verdict channel; the frame's recorded failure is cleared and the environment is stood up again,
// and the provider's next verdict settles it. Same rule as the teardown probe (only a `confirmed`
// probe is a reclaim) and the bugfix reproduction proof (only red-then-green is proof).
//
// Tracker: `docs/initiatives/deployment-failure-remediation.md`.
// ---------------------------------------------------------------------------

/** The provisioning failure a round is dispatched against. */
export interface DeployFixFailure {
  /** The service frame whose provision failed. */
  frameId: string
  /** That frame's title, for the brief the fixer reads. */
  frameTitle: string
  /** The provisioning config the failed attempt ran against, when the deployer pinned one. */
  provisioning: ServiceProvisioning | undefined
  /** The verbatim provider error. */
  error: string
  /**
   * The machine-readable cause, off the thrown `DomainError`'s `details.reason`. Absent when the
   * provider did not classify, which is NOT the same as a benign cause and is treated as
   * not-fixable: "we could not tell what went wrong" is not evidence that an edit would help.
   */
  reason: string | undefined
}

/** Collaborators the loop needs; the dispatcher binds them as it does for the deployer. */
export interface DeployFixControllerDeps {
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  runStateMachine: RunStateMachine
  clock: Clock
  /**
   * Where the give-up card is raised. Optional for the reason every other controller's is: a
   * deployment running without notifications must still fail its runs.
   */
  notificationService?: NotificationService
  logger?: Logger
}

/**
 * How much of a provider error is quoted into the fixer's brief. A Kubernetes rejection carries a
 * full `Status` object and a compose failure its whole log tail, either of which can run to tens of
 * kilobytes of the same repeated cause. The head names the object and field at fault, which is what
 * the fixer works from.
 */
const ERROR_BRIEF_CAP = 4000

export class DeployFixController {
  private readonly log: Logger

  constructor(private readonly deps: DeployFixControllerDeps) {
    this.log = (deps.logger ?? noopLogger).child({ scope: 'deployFix' })
  }

  /**
   * Escalate a failed PRIMARY-frame provision to the `deploy-fixer`, parking the run on its job.
   *
   * Returns `null` when this failure must NOT be remediated, and the caller then takes its
   * ordinary terminal-failure path unchanged. That is what keeps the whole feature a pass-through
   * wherever it cannot apply:
   *
   *   - the cause is not repo-fixable, or was never classified (the common case, and the point);
   *   - the step's author disabled the loop or set its budget to zero;
   *   - the budget is spent (the replay guard);
   *   - there is no async executor to dispatch a container with;
   *   - the dispatch failed, most often because the run has no pull request yet, which the
   *     `deploy-fixer`'s `requirePr` clone refuses. A deployer running before any PR exists has no
   *     branch for a fix to land on, and inventing one would push deployment edits onto base.
   *
   * A dispatch failure is deliberately not reported in place of the deploy error: it is a fact
   * about the REMEDIATION, where the run's actual problem is still the provision that broke.
   */
  async escalate(args: {
    workspaceId: string
    instance: ExecutionInstance
    step: PipelineStep
    block: Block
    isFinalStep: boolean
    failure: DeployFixFailure
  }): Promise<AdvanceResult | null> {
    const { workspaceId, instance, step, block, isFinalStep, failure } = args
    // The precondition, checked FIRST and before anything is spent. See the module header.
    if (!isRepoFixableEnvironmentFailure(failure.reason)) return null
    const budget = resolveDeployFixBudget(step)
    if (budget <= 0) return null
    const attempts = step.deployFix?.attempts ?? 0
    // The bar is the one FROZEN at the first escalation wherever there is one, never the freshly
    // resolved budget: editing the pipeline mid-run must not move the bar the rounds already
    // spent were counted against, the same rule an approval's quorum follows.
    const bar = step.deployFix?.maxAttempts ?? budget
    if (attempts >= bar) {
      // The ONE `null` that means the loop ran and gave up, rather than never applying — which is
      // why the card is raised here and at none of the other five. Reachable only with a round
      // already spent: a step with no `deployFix` has `attempts` 0 against a bar of at least 1.
      await this.raiseDeployBlocked({ workspaceId, instance, block, attempts, failure })
      return null
    }
    const executor = this.deps.agentExecutor
    if (!isAsyncAgentExecutor(executor)) return null

    let handle
    try {
      const base = await this.deps.contextBuilder.buildContext(
        workspaceId,
        instance,
        step,
        isFinalStep,
        block,
        { agentKind: DEPLOY_FIXER_AGENT_KIND },
      )
      const context: AgentRunContext = {
        ...base,
        agentKind: DEPLOY_FIXER_AGENT_KIND,
        // The brief rides `priorOutputs` tagged as the deployer's, which is whose output it is;
        // the fixer's own prompt lifts it back out and leads with it.
        priorOutputs: [
          ...base.priorOutputs,
          { agentKind: DEPLOY_FAILURE_PRIOR_KIND, output: describeDeployFailure(failure) },
        ],
      }
      handle = await executor.startJob(context)
    } catch (error) {
      await runBestEffort(this.log, 'deployFix.dispatch', () => Promise.reject(error), {
        workspaceId,
        executionId: instance.id,
        blockId: block.id,
        frameId: failure.frameId,
      })
      return null
    }

    step.jobId = handle.jobId
    // Provisioning settles on the durable poll path, which rebuilds the handle from the STEP
    // alone, so the resolved model, the leased subscription token and the initiating user have to
    // be persisted here or attribution lands as "unknown" in production.
    recordDispatchAttribution(step, handle, DEPLOY_FIXER_AGENT_KIND)
    step.container = { status: 'up' }
    step.deployFix = {
      ...step.deployFix,
      phase: 'fixing',
      attempts: attempts + 1,
      // Frozen at the FIRST escalation, so editing the pipeline mid-run cannot move the bar the
      // rounds already spent were counted against (as an approval's quorum is frozen at raise).
      maxAttempts: step.deployFix?.maxAttempts ?? budget,
      frameId: failure.frameId,
      reason: failure.reason,
      lastError: failure.error,
    }
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * The give-up card, raised when the loop has spent its budget and the environment is still not
   * up. The run then takes its ordinary terminal-failure path, so this is the `ci_failed` shape
   * exactly: the machine says it stopped trying, and acting on the card retries the run.
   *
   * It does NOT park the run for a human to confirm anything. An earlier cut did, on the theory
   * that exhaustion meant external blockers somebody had to clear first, but classification
   * upstream is what handles those now: a cause outside the repository never enters this loop at
   * all. What is left when the budget runs out is two failed attempts at a genuinely invalid
   * manifest, which is a plain failure to report and not a decision to ask for.
   *
   * Best-effort, because the run's actual problem is the provision that broke. A notification
   * backend that is down must not turn a reportable deployment failure into an unhandled throw
   * out of the deployer's own failure path.
   */
  private async raiseDeployBlocked(args: {
    workspaceId: string
    instance: ExecutionInstance
    block: Block
    attempts: number
    failure: DeployFixFailure
  }): Promise<void> {
    const { workspaceId, instance, block, attempts, failure } = args
    const service = this.deps.notificationService
    if (!service) return
    await runBestEffort(
      this.log,
      'deployFix.notify',
      () =>
        service.raise(workspaceId, {
          type: 'deploy_blocked',
          blockId: block.id,
          executionId: instance.id,
          title: `Deployment of "${failure.frameTitle}" is still failing for "${block.title}"`,
          body: [
            `The deploy-fixer agent tried ${attempts} time(s) and the environment still could not ` +
              'be stood up. The deployment files it edited are on the pull-request branch. Take a ' +
              'look and retry the run once fixed.',
            '',
            capError(failure.error),
          ].join('\n'),
          payload: {
            ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
            pipelineName: instance.pipelineName,
          },
        }),
      { workspaceId, executionId: instance.id, blockId: block.id, frameId: failure.frameId },
    )
  }

  /**
   * Settle a finished `deploy-fixer` job. Called from the job-poll path INSTEAD of recording a
   * step result: the fixer's job is not the deployer step's own work, exactly as a gate helper's
   * is not the gate's. Returns `null` when no fixer is in flight, so the caller falls through.
   *
   * Every settled round takes the same path, whether the container finished or died: clear the
   * frame's recorded failure and let the driver re-enter the deployer, which finds the frame
   * un-settled and provisions it again. The round is recorded either way, and the provision is
   * what decides. A job that died without pushing simply leaves the same failure to be re-classified
   * on the next pass, which spends the next round rather than inventing a verdict about it.
   */
  async resolveFixerCompletion(args: {
    workspaceId: string
    instance: ExecutionInstance
    step: PipelineStep
    update: Extract<AgentJobUpdate, { state: 'done' } | { state: 'failed' }>
  }): Promise<AdvanceResult | null> {
    const { workspaceId, instance, step, update } = args
    const fix = step.deployFix
    if (fix?.phase !== 'fixing') return null

    const attempt: DeployFixAttempt = {
      attempt: fix.attempts,
      at: this.deps.clock.now(),
      outcome: update.state === 'done' ? 'completed' : 'failed',
      reason: fix.reason,
      error: fix.lastError,
      summary:
        update.state === 'done'
          ? (update.result.output ?? null)
          : (update.error ?? 'The deploy-fixer job failed without finishing.'),
    }
    step.deployFix = {
      ...fix,
      phase: 'retrying',
      attemptLog: [...(fix.attemptLog ?? []), attempt],
    }
    // Drop the handle so a replay re-attaches to nothing and the deployer's own re-entry is not
    // mistaken for a re-attach. The container RECORD is left as the deploy path maintains it: the
    // deployer stamps it afresh at the next dispatch.
    step.jobId = undefined
    step.subtasks = undefined

    // Clearing this frame's TERMINAL outcome is what makes the re-provision happen: the fan-out
    // resumes at the first frame with none recorded, so the deployer needs no knowledge of this
    // loop to do the right thing on re-entry.
    if (step.deployEnvs) {
      const { [fix.frameId]: _cleared, ...rest } = step.deployEnvs
      step.deployEnvs = rest
    }
    // The deployer pins the config its container was built from at dispatch; a retry must resolve
    // the frame fresh, since the fixer may well have changed what it declares.
    step.deployProvisioning = undefined
    step.deployFrameId = undefined
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance, {
      blockStatus: 'in_progress',
    })
    return { kind: 'continue' }
  }
}

/**
 * The attempt budget for this step: the author's per-step override, else the shipped default.
 * `enabled: false` is expressed as a zero budget so the disabled case and the deliberately
 * zero-rounds case take one path, there being no difference between them.
 */
export function resolveDeployFixBudget(step: Pick<PipelineStep, 'stepOptions'>): number {
  const config = step.stepOptions?.deployFix
  if (config?.enabled === false) return 0
  return config?.maxAttempts ?? DEFAULT_DEPLOY_FIX_MAX_ATTEMPTS
}

/**
 * The failure brief the fixer reads. It names the frame and the declared provisioning shape
 * alongside the error, because the error alone says what the platform rejected and not where the
 * files that produced it live: a `kubernetes` frame rendering `deploy/k8s` and a `docker-compose`
 * frame send the agent to different parts of the repository.
 */
export function describeDeployFailure(failure: DeployFixFailure): string {
  return [
    `Deployment of service '${failure.frameTitle}' failed.`,
    failure.provisioning
      ? `Declared provisioning: ${describeProvisioning(failure.provisioning)}`
      : 'Declared provisioning: none recorded for this frame.',
    '',
    'The provisioning platform reported:',
    capError(failure.error),
  ].join('\n')
}

/**
 * The provisioning config in one line: its type plus where the files it renders live.
 *
 * A `separate` manifest source is named as a different repository EXPLICITLY, because that is the
 * one case where the fixer's checkout does not contain the thing at fault. Left implicit, an agent
 * handed a manifest error looks for the manifests in the repo it is standing in, fails to find
 * them, and either concludes the wrong thing or starts writing new ones.
 */
function describeProvisioning(provisioning: ServiceProvisioning): string {
  const source = provisioning.manifestSource
  const compose = provisioning.composePath
  if (!source) {
    return compose ? `${provisioning.type}, compose file '${compose}'` : provisioning.type
  }
  const where =
    source.type === 'colocated'
      ? `in-repo path '${source.path}'`
      : `the SEPARATE repository '${source.repo}' at path '${source.path}'${
          source.ref ? ` (ref ${source.ref})` : ''
        }, which is NOT the repository you have checked out`
  const renderer = source.renderer ? `, rendered with ${source.renderer}` : ''
  return `${provisioning.type}, manifests from ${where}${renderer}`
}

/**
 * The error, capped. It states the drop explicitly rather than trailing off, so a reader cannot
 * mistake a truncated error for one that genuinely ended there and conclude the tail was never
 * produced.
 */
function capError(error: string): string {
  if (error.length <= ERROR_BRIEF_CAP) return error
  const dropped = error.length - ERROR_BRIEF_CAP
  return `${error.slice(0, ERROR_BRIEF_CAP)}\n[…${dropped} more characters of this error were not included]`
}
