import type {
  Block,
  Clock,
  EnvironmentInvestigationSubject,
  EnvironmentInvestigator,
  ExecutionInstance,
  Logger,
  PipelineStep,
} from '@cat-factory/kernel'
import { describeError, getErrorMessage, noopLogger } from '@cat-factory/kernel'
import {
  coerceEnvironmentInvestigationVerdict,
  DEFAULT_ENVIRONMENT_INVESTIGATION_MAX_ATTEMPTS,
  describeRemediationAction,
  type EnvironmentInvestigationAttempt,
  type EnvironmentInvestigationVerdict,
  type EnvironmentRemediationAction,
  environmentRemediationActionSchema,
  MAX_ENVIRONMENT_WAIT_EXTENSIONS,
  remediationNeedsProviderSupport,
} from '@cat-factory/contracts'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'

// ---------------------------------------------------------------------------
// The `deployer`'s INVESTIGATION loop: when a provision fails for a cause NO checkout edit can
// address, diagnose it against the provider's own evidence and, when there is something to try,
// try it and let the provider's next verdict settle whether it worked.
//
// It is the other half of `DeployFixController`, and the two are mutually exclusive by
// construction: the fixer runs only for `manifest_invalid`, this runs only when the fixer
// declined. Between them every failed provision now gets either a repair or an explanation, where
// before, everything outside the one repo-fixable class ended the run at the tester with a report
// correctly concluding that a human had to look.
//
// WHY THIS IS NOT A CONTAINER AGENT. Three reasons, any one of which is sufficient. The evidence
// is entirely platform-side (a registry row, a field bag, a provisioning log, a provider API), so
// a checkout buys nothing. The credentials that read that provider must never ride a job body,
// which is the same rule the release-health connections follow. And the actions are
// `EnvironmentProvider` calls the engine already makes, so handing them to an agent would mean
// exporting a control plane rather than asking a question.
//
// WHAT MAKES THIS A DIAGNOSIS RATHER THAN A GUESS. The model chooses from a CLOSED action
// vocabulary, narrowed before it is asked to the actions this step's configuration, this round's
// budget and this provider actually allow, so a verdict can never name a remedy the engine then
// silently declines. And no verdict is ever the proof: every action is followed by the deployer
// re-entering its own path, so what settles the frame is the provider, exactly as it is for the
// deploy-fixer, the teardown probe and the bugfix reproduction proof.
//
// Tracker: `docs/initiatives/environment-investigation.md`.
// ---------------------------------------------------------------------------

/** The provisioning failure a round is run against. */
export interface EnvironmentInvestigationFailure {
  /** The service frame whose provision failed. */
  frameId: string
  /** That frame's title, for the record. */
  frameTitle: string
  /** The environment the provision broke ON, when one was recorded before it broke. */
  environmentId: string | null
  /** The verbatim provider error. */
  error: string
  /** The machine-readable cause, when the provider classified one. */
  reason: string | undefined
  /** How long the readiness wait ran, when this failure came out of one. */
  waitedMs?: number
}

/**
 * What the loop decided. `null` (not a member) is "does not apply", and the caller then takes its
 * ordinary terminal-failure path byte-for-byte as it did before this existed.
 */
export type EnvironmentInvestigationOutcome =
  /** Something was tried; the run continues on the returned advance. */
  | { kind: 'retrying'; advance: AdvanceResult }
  /**
   * Nothing was tried, and the failure is still terminal, but it now has a NAMED cause, which
   * replaces the message the run records. The second of the two outcomes the feature owes: a stop
   * with an explanation instead of a tester guessing from a DNS failure.
   */
  | { kind: 'reported'; message: string }

/** Collaborators the loop needs; the dispatcher binds them as it does for the deploy fixer. */
export interface EnvironmentInvestigationControllerDeps {
  investigator?: EnvironmentInvestigator
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Tear an environment down, for the `recreate` remedy. Typed structurally (not the concrete
   * `EnvironmentTeardownService`) exactly as the provisioning service types its own. Absent ⇒
   * `recreate` is not offered and the model is never asked to pick it.
   */
  environmentTeardown?: { teardown(workspaceId: string, id: string): Promise<unknown> }
  runStateMachine: RunStateMachine
  clock: Clock
  logger?: Logger
}

export class EnvironmentInvestigationController {
  private readonly log: Logger

  constructor(private readonly deps: EnvironmentInvestigationControllerDeps) {
    this.log = (deps.logger ?? noopLogger).child({ scope: 'environmentInvestigation' })
  }

  /**
   * Investigate a failed PRIMARY-frame provision, and act on the verdict when there is something
   * to act on.
   *
   * Returns `null` when this failure must NOT be investigated, which is what keeps the whole
   * feature a pass-through wherever it cannot apply:
   *
   *   - no investigator is wired (no model provider / no routing default), or no provisioning
   *     service to read the evidence with;
   *   - the step's author disabled the loop or set its budget to zero.
   *
   * A budget that is SPENT is not one of those: the loop ran, and its last verdict is reported
   * rather than thrown away, so the terminal failure still names what was found.
   */
  async investigate(args: {
    workspaceId: string
    instance: ExecutionInstance
    step: PipelineStep
    block: Block
    failure: EnvironmentInvestigationFailure
  }): Promise<EnvironmentInvestigationOutcome | null> {
    const { workspaceId, instance, step, block, failure } = args
    const investigator = this.deps.investigator
    const provisioning = this.deps.environmentProvisioning
    if (!investigator?.enabled || !provisioning) return null
    const budget = resolveEnvironmentInvestigationBudget(step)
    if (budget <= 0) return null

    const state = step.environmentInvestigation
    const attempts = state?.attempts ?? 0
    // The bar is the one FROZEN at the first round wherever there is one, never the freshly
    // resolved budget: editing the pipeline mid-run must not move the bar the rounds already spent
    // were counted against, the same rule the deploy fixer's budget and an approval's quorum follow.
    const bar = state?.maxAttempts ?? budget
    if (attempts >= bar) {
      // The loop ran and is out of rounds. The last verdict is still the best account anybody has
      // of this failure, so it is reported rather than discarded: reporting is the point, and a
      // spent budget removes only the ability to act on it.
      const last = lastVerdict(step)
      return last ? { kind: 'reported', message: describeFinding(failure, last, true) } : null
    }

    const offered = await this.offeredActions(workspaceId, step, failure)
    const subject: EnvironmentInvestigationSubject = {
      workspaceId,
      executionId: instance.id,
      block,
      evidence: await provisioning.collectEnvironmentEvidence({
        workspaceId,
        environmentId: failure.environmentId,
        executionId: instance.id,
        failure: {
          error: failure.error,
          ...(failure.reason ? { reason: failure.reason } : {}),
          ...(failure.waitedMs === undefined ? {} : { waitedMs: failure.waitedMs }),
        },
      }),
      offeredActions: offered,
    }

    let verdict: EnvironmentInvestigationVerdict | null = null
    let investigationFailure: string | undefined
    try {
      const answer = await investigator.investigate(subject)
      verdict = coerceEnvironmentInvestigationVerdict(answer.verdict)
      if (!verdict) investigationFailure = 'The investigation returned no readable verdict.'
    } catch (error) {
      investigationFailure = getErrorMessage(error)
      this.log.warn('environment investigation could not be completed', {
        workspaceId,
        executionId: instance.id,
        frameId: failure.frameId,
        environmentId: failure.environmentId,
        ...describeError(error),
      })
    }

    const round = { attempt: attempts + 1, at: this.deps.clock.now() } as const
    if (!verdict) {
      // An investigation that could not be READ is not a clean bill of health and is not a verdict
      // of `stop` either. The round is recorded so the budget cannot be spun, and the caller takes
      // its unchanged terminal path with the run's real error.
      appendRound(step, failure, budget, {
        ...round,
        outcome: 'failed',
        reason: failure.reason ?? null,
        error: failure.error,
        failure: investigationFailure ?? 'The investigation could not be completed.',
      })
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      return null
    }

    const chosen = this.chooseAction(verdict, offered)
    if (!chosen.action) {
      appendRound(step, failure, budget, {
        ...round,
        outcome: 'reported',
        reason: failure.reason ?? null,
        error: failure.error,
        verdict,
        ...(chosen.withheld ? { withheld: chosen.withheld } : {}),
      })
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      return { kind: 'reported', message: describeFinding(failure, verdict, false) }
    }

    const applied = await this.applyAction(provisioning, workspaceId, failure, chosen.action)
    appendRound(step, failure, budget, {
      ...round,
      outcome: applied.ok ? 'remediated' : 'reported',
      reason: failure.reason ?? null,
      error: failure.error,
      verdict,
      ...(applied.ok ? { ranAction: chosen.action } : { withheld: applied.detail }),
    })
    if (!applied.ok) {
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      return {
        kind: 'reported',
        message: [
          describeFinding(failure, verdict, false),
          '',
          'The platform tried to ' +
            describeRemediationAction(chosen.action) +
            ' and could not: ' +
            applied.detail,
        ].join('\n'),
      }
    }
    return {
      kind: 'retrying',
      advance: await this.resume(workspaceId, instance, step, chosen.action, failure),
    }
  }

  /**
   * The actions the engine will honour THIS round, narrowed before the model is asked.
   *
   * Narrowing here rather than filtering the verdict afterwards is what stops a report naming a
   * remedy nobody tried: an operator reading "the platform should have restarted the workload"
   * against a provider that cannot restart anything has been told about a decision that never
   * existed. The filter runs over the vocabulary's OWN options, so a new action is unreachable
   * until it is decided about here as well as in the contracts' support `Record`.
   */
  private async offeredActions(
    workspaceId: string,
    step: PipelineStep,
    failure: EnvironmentInvestigationFailure,
  ): Promise<EnvironmentRemediationAction[]> {
    const config = step.stepOptions?.environmentInvestigation
    const extensions = step.environmentInvestigation?.waitExtensions ?? 0
    // Not asked at all when the deployment has forbidden acting: the answer could only narrow a
    // set that is already down to `stop`, and it is a live call to somebody's control plane.
    const supported: readonly string[] =
      failure.environmentId && config?.allowRemediation !== false
        ? await this.providerActions(workspaceId, failure.environmentId)
        : []
    return environmentRemediationActionSchema.options.filter((action) => {
      // Refusing is always available.
      if (action === 'stop') return true
      // A deployment may keep the whole diagnosis and forbid everything that touches infrastructure.
      if (config?.allowRemediation === false) return false
      // Only the provider's own in-place remedies need it to have implemented anything.
      if (remediationNeedsProviderSupport(action) && !supported.includes(action)) return false
      // Waiting longer answers OUR deadline expiring on an environment the provider still said was
      // coming. A provider that has DECLARED the environment failed answers identically forever,
      // so a wait there is an offer to postpone the same verdict.
      if (action === 'wait') {
        return (
          !!failure.environmentId &&
          failure.reason === 'timeout' &&
          extensions < MAX_ENVIRONMENT_WAIT_EXTENSIONS
        )
      }
      // Tearing down needs both something to tear down and a teardown seam to do it with.
      if (action === 'recreate') return !!failure.environmentId && !!this.deps.environmentTeardown
      // `restart` acts ON an environment; `reprovision` stands one up, and is therefore the one
      // remedy still available when the provision died before recording an environment at all.
      if (action === 'restart') return !!failure.environmentId
      return true
    })
  }

  /** The provider's declared in-place remediations; a read failure degrades to "none offered". */
  private async providerActions(workspaceId: string, environmentId: string): Promise<string[]> {
    try {
      return [
        ...((await this.deps.environmentProvisioning?.providerRemediations(
          workspaceId,
          environmentId,
        )) ?? []),
      ]
    } catch (error) {
      this.log.warn('could not read the provider remediations for an environment', {
        workspaceId,
        environmentId,
        ...describeError(error),
      })
      return []
    }
  }

  /**
   * Resolve the verdict's action against what was offered. An action outside the offered set is
   * treated as `stop` with the divergence NAMED: the model was told the list, so picking outside
   * it is a contract violation, and quietly substituting a neighbouring action would be the engine
   * choosing a remedy nobody asked for.
   */
  private chooseAction(
    verdict: EnvironmentInvestigationVerdict,
    offered: readonly EnvironmentRemediationAction[],
  ): { action?: EnvironmentRemediationAction; withheld?: string } {
    if (verdict.action === 'stop') return {}
    if (!offered.includes(verdict.action)) {
      return {
        withheld:
          `The investigation asked the platform to ${describeRemediationAction(verdict.action)}, ` +
          'which was not offered this round.',
      }
    }
    return { action: verdict.action }
  }

  /**
   * Run the chosen action. Never throws: a failed remedy is a reported outcome, not a crashed run.
   *
   * The collaborators are PARAMETERS rather than reads off `this`, and the environment id is
   * re-checked here rather than assumed from {@link offeredActions}: a `!` asserting a guard made
   * in another method is exactly the assertion that silently stops being true when a second caller
   * appears.
   */
  private async applyAction(
    provisioning: EnvironmentProvisioningService,
    workspaceId: string,
    failure: EnvironmentInvestigationFailure,
    action: EnvironmentRemediationAction,
  ): Promise<{ ok: boolean; detail: string }> {
    const environmentId = failure.environmentId
    try {
      if (action === 'restart') {
        if (!environmentId) {
          return { ok: false, detail: 'no environment was recorded for this frame to restart' }
        }
        const outcome = await provisioning.remediateEnvironment({
          workspaceId,
          environmentId,
          action: 'restart',
        })
        // A provider that found nothing to restart reports `applied: false`, and treating that as
        // success would have the engine re-probe an untouched environment and read the unchanged
        // verdict as a remedy that did not work.
        return { ok: outcome.applied, detail: outcome.detail }
      }
      if (action === 'recreate') {
        const teardown = this.deps.environmentTeardown
        if (!environmentId || !teardown) {
          return { ok: false, detail: 'there is no environment this deployment can tear down' }
        }
        await teardown.teardown(workspaceId, environmentId)
        return { ok: true, detail: 'the environment was torn down before being stood up again' }
      }
      // `wait` and `reprovision` are entirely engine-side: nothing is asked of the provider here,
      // and what they do happens in `resume`.
      return { ok: true, detail: '' }
    } catch (error) {
      // Deliberately NOT swallowed as best-effort: `recreate` re-provisions over whatever the
      // teardown left behind, so a teardown that failed has to stop the retry rather than
      // reproduce the fault against half-removed infrastructure.
      this.log.warn('an environment remediation could not be applied', {
        workspaceId,
        environmentId,
        action,
        ...describeError(error),
      })
      return { ok: false, detail: getErrorMessage(error) }
    }
  }

  /**
   * Hand the frame back to the deployer so its own path decides what the remedy achieved.
   *
   * `wait` re-enters the readiness park on the SAME environment with a fresh anchor, which is what
   * grants it another ceiling without the readiness judgement needing to know this loop exists.
   * Everything else clears the frame's TERMINAL outcome, which is what makes the re-provision
   * happen: the fan-out resumes at the first frame with none recorded, so the deployer needs no
   * knowledge of this loop either.
   */
  private async resume(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    action: EnvironmentRemediationAction,
    failure: EnvironmentInvestigationFailure,
  ): Promise<AdvanceResult> {
    clearFrameOutcome(step, failure.frameId)
    // `wait` and `restart` both leave the SAME environment in place and hand it back to the
    // readiness park: one because our own deadline was the only thing that expired, the other
    // because a restart is an in-place change the provider makes asynchronously, and standing the
    // environment up again would discard the very thing the restart was meant to fix.
    if ((action === 'wait' || action === 'restart') && failure.environmentId) {
      step.deployWait = {
        frameId: failure.frameId,
        environmentId: failure.environmentId,
        startedAt: this.deps.clock.now(),
        polls: 0,
      }
      if (action === 'wait' && step.environmentInvestigation) {
        step.environmentInvestigation = {
          ...step.environmentInvestigation,
          waitExtensions: (step.environmentInvestigation.waitExtensions ?? 0) + 1,
        }
      }
      await this.deps.runStateMachine.persistAndEmit(workspaceId, instance, {
        blockStatus: 'in_progress',
      })
      return { kind: 'awaiting_environment', stepIndex: instance.currentStep }
    }
    // The deployer pins the config its container was built from at dispatch; a retry must resolve
    // the frame fresh. A readiness wait belongs to the environment this round supersedes, so
    // carrying it over would park the re-provision on the OLD environment's id.
    step.deployProvisioning = undefined
    step.deployFrameId = undefined
    step.deployWait = undefined
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance, {
      blockStatus: 'in_progress',
    })
    return { kind: 'continue' }
  }
}

/**
 * Append one round to the step's investigation state. A pure mutation: every exit path persists
 * exactly once, so the acting path does not write the run twice for one decision.
 */
function appendRound(
  step: PipelineStep,
  failure: EnvironmentInvestigationFailure,
  budget: number,
  attempt: EnvironmentInvestigationAttempt,
): void {
  const state = step.environmentInvestigation
  step.environmentInvestigation = {
    ...state,
    attempts: attempt.attempt,
    maxAttempts: state?.maxAttempts ?? budget,
    frameId: failure.frameId,
    environmentId: failure.environmentId,
    attemptLog: [...(state?.attemptLog ?? []), attempt],
  }
}

/**
 * The attempt budget for this step: the author's per-step override, else the shipped default.
 * `enabled: false` is expressed as a zero budget so the disabled case and the deliberately
 * zero-rounds case take one path, there being no difference between them.
 */
export function resolveEnvironmentInvestigationBudget(
  step: Pick<PipelineStep, 'stepOptions'>,
): number {
  const config = step.stepOptions?.environmentInvestigation
  if (config?.enabled === false) return 0
  return config?.maxAttempts ?? DEFAULT_ENVIRONMENT_INVESTIGATION_MAX_ATTEMPTS
}

/** Drop one frame's recorded TERMINAL outcome, so the fan-out resumes at it on re-entry. */
function clearFrameOutcome(step: PipelineStep, frameId: string): void {
  if (!step.deployEnvs) return
  const { [frameId]: _cleared, ...rest } = step.deployEnvs
  step.deployEnvs = rest
}

/** The most recent round that produced a verdict, or undefined when none did. */
function lastVerdict(step: PipelineStep): EnvironmentInvestigationVerdict | undefined {
  const log = step.environmentInvestigation?.attemptLog ?? []
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const verdict = log[i]?.verdict
    if (verdict) return verdict
  }
  return undefined
}

/**
 * The terminal failure message a reported verdict replaces the bare provider error with. The
 * provider error is kept and LEADS, because it is still the primary fact; the finding is stated
 * under it so a reader gets the cause without losing what was actually observed.
 */
export function describeFinding(
  failure: EnvironmentInvestigationFailure,
  verdict: EnvironmentInvestigationVerdict,
  budgetSpent: boolean,
): string {
  const lines = [
    failure.error,
    '',
    `Environment investigation of "${failure.frameTitle}" (fault: ${verdict.faultLayer}): ${
      verdict.summary || 'no summary was produced.'
    }`,
  ]
  if (verdict.evidence.length > 0) {
    lines.push('', 'Evidence:')
    for (const item of verdict.evidence) lines.push(`- [${item.source}] ${item.statement}`)
  }
  lines.push(
    '',
    budgetSpent
      ? 'The investigation budget for this step is spent; nothing further was attempted.'
      : `Recommended: ${describeRemediationAction(verdict.action)}${
          verdict.actionRationale ? `. ${verdict.actionRationale}` : ''
        }`,
  )
  return lines.join('\n')
}
