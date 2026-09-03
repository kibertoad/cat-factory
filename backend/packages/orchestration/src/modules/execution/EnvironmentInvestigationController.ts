import type {
  Block,
  Clock,
  EnvironmentInvestigationSubject,
  EnvironmentInvestigator,
  ExecutionInstance,
  Logger,
  PipelineStep,
  TeardownConfirmation,
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
  MAX_ENVIRONMENT_INVESTIGATION_ATTEMPT_LOG,
  MAX_ENVIRONMENT_WAIT_EXTENSIONS,
  remediationNeedsProviderSupport,
} from '@cat-factory/contracts'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import type { AdvanceResult } from './advance.js'
import { appendAttemptLog } from './deployer.logic.js'
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
  /** What the readiness wait contributed to this failure. See {@link EnvironmentReadinessWait}. */
  wait: EnvironmentReadinessWait
}

/**
 * Which of the three readiness stories this failure has, because "no elapsed time" is not one
 * fact.
 *
 * A nullable `waitedMs` collapsed them, and the missing case then rendered as a claim: every
 * failure route that is not the readiness ceiling (a deploy container shut down mid-run, a
 * `startProvision` throw, a `finalizeProvision` throw) told the investigator there had been a live
 * verdict and nothing had waited on it, directly above the directive telling it to line the
 * timestamps up. Two of those had no readiness verdict at all and one of them ran for twenty
 * minutes.
 *
 *  - `waited`: a readiness wait ran and was given up on. `waitedMs` says how long.
 *  - `verdict_without_wait`: the provider DECLARED the environment failed, so nothing waited.
 *  - `not_reached`: the failure happened before any readiness judgement, so the wait says nothing
 *    about it either way.
 */
export type EnvironmentReadinessWait =
  | { kind: 'waited'; waitedMs: number }
  | { kind: 'verdict_without_wait' }
  | { kind: 'not_reached' }

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
   *
   * The RESULT is part of the structural type, not `unknown`: a teardown returns the independent
   * probe's verdict, and `recreate` re-provisions over whatever it left behind. Only a `confirmed`
   * probe is a reclaim (the disposal rule), so the shape has to carry the verdict for the caller
   * to be able to refuse a namespace still wedged in `Terminating`.
   */
  environmentTeardown?: {
    teardown(
      workspaceId: string,
      id: string,
    ): Promise<{ confirmation: TeardownConfirmation; reason: string | null }>
  }
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
      return last
        ? { kind: 'reported', message: describeFinding(failure, last, { kind: 'budget_spent' }) }
        : null
    }

    let verdict: EnvironmentInvestigationVerdict | null = null
    let investigationFailure: string | undefined
    let offered: readonly EnvironmentRemediationAction[] = []
    // GATHERING is inside the guard, not just the asking. The evidence walk is a chain of
    // repository and provider reads, and one of them throwing here does not merely cost the
    // diagnosis: it propagates out of the caller's own terminal-failure path, where the durable
    // driver counts it as an unreadable poll and fast-fails the run as a `timeout`. The loop
    // exists to EXPLAIN a failed provision, so it must never be able to replace one with a
    // misattributed failure of its own.
    try {
      const evidence = await provisioning.collectEnvironmentEvidence({
        workspaceId,
        environmentId: failure.environmentId,
        executionId: instance.id,
        failure: {
          error: failure.error,
          ...(failure.reason ? { reason: failure.reason } : {}),
          ...(failure.wait.kind === 'waited' ? { waitedMs: failure.wait.waitedMs } : {}),
          readinessWait: failure.wait.kind,
        },
      })
      offered = offeredActions(
        step,
        failure,
        evidence.providerActions,
        !!this.deps.environmentTeardown,
      )
      const subject: EnvironmentInvestigationSubject = {
        workspaceId,
        executionId: instance.id,
        block,
        evidence: evidence.bundle,
        offeredActions: offered,
      }
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

    const round = { attempt: nextRoundOrdinal(state), at: this.deps.clock.now() } as const
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

    const chosen = chooseAction(verdict, offered)
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
      return {
        kind: 'reported',
        // The WITHHELD reason, never the verdict's own recommendation: the action was refused
        // before it was taken, so printing `Recommended: restart` would tell the operator about a
        // decision that never existed. That is the exact outcome `offeredActions` narrows to
        // prevent, and it survives only if the message it produces says so too.
        message: describeFinding(
          failure,
          verdict,
          chosen.withheld ? { kind: 'withheld', detail: chosen.withheld } : { kind: 'recommended' },
        ),
      }
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
        message: describeFinding(failure, verdict, {
          kind: 'attempt_failed',
          action: chosen.action,
          detail: applied.detail,
        }),
      }
    }
    return {
      kind: 'retrying',
      advance: await this.resume(workspaceId, instance, step, chosen.action, failure),
    }
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
        const result = await teardown.teardown(workspaceId, environmentId)
        // Only a CONFIRMED probe is a reclaim. A teardown that returns without throwing says the
        // provider accepted the destroy call, which is a different fact from the environment being
        // gone: a namespace wedged in `Terminating` behind a stuck finalizer answers exactly that
        // way, and re-provisioning into it reproduces the fault and burns the remaining round.
        if (result.confirmation !== 'confirmed') {
          return {
            ok: false,
            detail:
              `the provider accepted the teardown but the environment could not be confirmed ` +
              `gone (${result.confirmation}${result.reason ? `: ${result.reason}` : ''})`,
          }
        }
        return { ok: true, detail: 'the environment was torn down before being stood up again' }
      }
      // `wait` and `reprovision` are entirely engine-side: nothing is asked of the provider here,
      // and what they do happens in `resume`.
      return { ok: true, detail: '' }
    } catch (error) {
      // Deliberately NOT swallowed as best-effort: `recreate` re-provisions over whatever the
      // teardown left behind, so a teardown that threw (like one whose probe found the
      // environment still standing, above) has to stop the retry rather than reproduce the fault
      // against half-removed infrastructure.
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
 * The actions the engine will honour THIS round, narrowed before the model is asked.
 *
 * Narrowing here rather than filtering the verdict afterwards is what stops a report naming a
 * remedy nobody tried: an operator reading "the platform should have restarted the workload"
 * against a provider that cannot restart anything has been told about a decision that never
 * existed. The filter runs over the vocabulary's OWN options, so a new action is unreachable
 * until it is decided about here as well as in the contracts' support `Record`.
 *
 * `supported` comes from the SAME provider resolve the evidence was gathered through, so a round
 * costs one registry read and one connection open rather than two of each.
 */
export function offeredActions(
  step: Pick<PipelineStep, 'stepOptions' | 'environmentInvestigation'>,
  failure: Pick<EnvironmentInvestigationFailure, 'environmentId' | 'reason'>,
  supported: readonly string[],
  canTearDown: boolean,
): EnvironmentRemediationAction[] {
  const config = step.stepOptions?.environmentInvestigation
  const extensions = step.environmentInvestigation?.waitExtensions ?? 0
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
    if (action === 'recreate') return !!failure.environmentId && canTearDown
    // `restart` acts ON an environment; `reprovision` stands one up, and is therefore the one
    // remedy still available when the provision died before recording an environment at all.
    if (action === 'restart') return !!failure.environmentId
    return true
  })
}

/**
 * Resolve the verdict's action against what was offered. An action outside the offered set is
 * treated as `stop` with the divergence NAMED: the model was told the list, so picking outside
 * it is a contract violation, and quietly substituting a neighbouring action would be the engine
 * choosing a remedy nobody asked for.
 */
function chooseAction(
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
 * Append one round to the step's investigation state. A pure mutation: every exit path persists
 * exactly once, so the acting path does not write the run twice for one decision.
 */
function appendRound(
  step: PipelineStep,
  failure: EnvironmentInvestigationFailure,
  budget: number,
  attempt: Omit<EnvironmentInvestigationAttempt, 'cycle'>,
): void {
  const state = step.environmentInvestigation
  const cycle = state?.cycle ?? 0
  step.environmentInvestigation = {
    ...state,
    // The CYCLE counter, which is what the budget is spent against; `attempt.attempt` is the
    // row's ordinal in the run-long log and the two diverge after a loop-back.
    attempts: (state?.attempts ?? 0) + 1,
    maxAttempts: state?.maxAttempts ?? budget,
    frameId: failure.frameId,
    environmentId: failure.environmentId,
    cycle,
    ...appendAttemptLog(
      state?.attemptLog,
      // Stamped with the cycle that ran it, so a reader of the run-long log can scope back to
      // the rounds this cycle spent: the environment an earlier cycle investigated is gone.
      { ...attempt, cycle },
      MAX_ENVIRONMENT_INVESTIGATION_ATTEMPT_LOG,
      state?.droppedAttempts,
    ),
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

/**
 * The next round's 1-based ordinal in the RUN-long log: the rows still held plus the rows the cap
 * has dropped.
 *
 * Off the LOG rather than the cycle counter, which is re-armed for each provisioning cycle while
 * the log survives the whole run (`restartEnvironmentInvestigationState`): the counter would
 * number a second cycle's first round `1` beside the row already holding it. Identical on a run
 * that never loops back.
 */
function nextRoundOrdinal(state: PipelineStep['environmentInvestigation']): number {
  return (state?.attemptLog?.length ?? 0) + (state?.droppedAttempts ?? 0) + 1
}

/**
 * The most recent round of THIS provisioning cycle that produced a verdict, or undefined when
 * none did.
 *
 * Scoped to the cycle rather than walked back over the whole log, which survives the run: a
 * verdict from a superseded cycle is a diagnosis of an environment the re-provision has already
 * destroyed, and reporting it as the account of this cycle's failure is exactly the
 * misattribution the per-cycle re-arm exists to prevent. No verdict this cycle answers
 * undefined, and the caller then takes its unchanged terminal path with the run's real error.
 */
function lastVerdict(step: PipelineStep): EnvironmentInvestigationVerdict | undefined {
  const state = step.environmentInvestigation
  const log = state?.attemptLog ?? []
  const cycle = state?.cycle ?? 0
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const round = log[i]
    if ((round?.cycle ?? 0) !== cycle) continue
    if (round?.verdict) return round.verdict
  }
  return undefined
}

/**
 * How the round ENDED, which decides the closing line of the operator's message.
 *
 * A discriminated union rather than a `budgetSpent` boolean, because three of these four
 * outcomes are not a recommendation and printing one as if it were is the misattribution the
 * whole narrow-before-you-ask design exists to prevent. `withheld` in particular: the engine
 * refused the action before it was taken, so `Recommended: restart the workload in place` would
 * name a decision that never existed, with the reason it was refused left in an attempt log
 * nothing surfaces.
 */
export type EnvironmentFindingClosing =
  /** The verdict's action was offered and is what the operator should consider. */
  | { kind: 'recommended' }
  /** The engine did not offer the action the verdict asked for; `detail` says why. */
  | { kind: 'withheld'; detail: string }
  /** The action ran and could not be completed. */
  | { kind: 'attempt_failed'; action: EnvironmentRemediationAction; detail: string }
  /** The budget was already spent, so this verdict is the last round's, reported unacted-on. */
  | { kind: 'budget_spent' }

/**
 * The terminal failure message a reported verdict replaces the bare provider error with. The
 * provider error is kept and LEADS, because it is still the primary fact; the finding is stated
 * under it so a reader gets the cause without losing what was actually observed.
 */
export function describeFinding(
  failure: EnvironmentInvestigationFailure,
  verdict: EnvironmentInvestigationVerdict,
  closing: EnvironmentFindingClosing,
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
  lines.push('', describeClosing(verdict, closing))
  return lines.join('\n')
}

/** Compile-time totality guard for {@link describeClosing}. */
function unhandledClosing(closing: never): string {
  return `The investigation ended in an unrecognised state (${JSON.stringify(closing)}).`
}

function describeClosing(
  verdict: EnvironmentInvestigationVerdict,
  closing: EnvironmentFindingClosing,
): string {
  // The verdict's reasoning is kept in the two cases where the action did NOT happen, because it
  // is what a person picking the action up by hand needs; it rides its own line so it can never
  // read as part of the platform's account of what it did.
  const because = verdict.actionRationale ? `\nIts reasoning was: ${verdict.actionRationale}` : ''
  switch (closing.kind) {
    case 'budget_spent':
      return 'The investigation budget for this step is spent; nothing further was attempted.'
    case 'withheld':
      return `${closing.detail}${because}`
    case 'attempt_failed':
      return (
        `The platform tried to ${describeRemediationAction(closing.action)} and could not: ` +
        `${closing.detail}${because}`
      )
    case 'recommended':
      return `Recommended: ${describeRemediationAction(verdict.action)}${
        verdict.actionRationale ? `. ${verdict.actionRationale}` : ''
      }`
    default:
      return unhandledClosing(closing)
  }
}
