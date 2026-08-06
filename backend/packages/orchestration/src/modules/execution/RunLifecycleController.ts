import type {
  AgentFailureKind,
  Block,
  BlockRepository,
  Clock,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  Logger,
  PipelineStep,
  SubscriptionActivationRepository,
  WorkRunner,
  WorkspaceRole,
} from '@cat-factory/kernel'
import type { PreloadedBlocks } from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  DEFAULT_RISK_POLICY,
  noopLogger,
  ValidationError,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { companionFor } from '@cat-factory/agents'
import { DEFAULT_COMPANION_MAX_ATTEMPTS, pipelineHasVisualStep } from '@cat-factory/contracts'
import type { PipelineAdoption } from '../pipelines/pipelineAdoption.js'
import { assertPipelineLaunchable } from '../pipelines/pipelineShape.js'
import { isTesterKind } from './ci.logic.js'
import { DEFAULT_FOLLOW_UP_MAX_LOOPS, FOLLOW_UP_PRODUCER_KIND } from './followUp.logic.js'
import { isRalphKind, resolveRalphConfig, seedRalphState } from './ralph.logic.js'
import { buildResumedInstance, planResumedSteps, planRestartFromStep } from './retry.logic.js'
import { claimLiveRunOrConflict, handOffLiveRun, type RunStartDeps } from './runStart.js'
import { settleRunModeForStart } from './runMode.logic.js'
import { descendantIds } from '../board/board.logic.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunAdmission } from './RunAdmission.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { RunStartOptions } from './runStartOptions.js'

/**
 * What the run-lifecycle surface needs. The two guards (`requireWorkspace` / `requireBlock`) and
 * `failRun` arrive as bound call-backs, so this controller depends on no concrete guard and on no
 * part of the state machine it does not itself drive.
 */
export interface RunLifecycleDeps {
  admission: RunAdmission
  /**
   * The app-owned agent-kind registry, so a DEPLOYMENT-registered companion's own default
   * threshold seeds its step at run start, exactly as a built-in's does.
   */
  agentKindRegistry: AgentKindRegistry
  blockRepository: BlockRepository
  clock: Clock
  contextBuilder: AgentContextBuilder
  events: ExecutionEventPublisher
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  /**
   * Resolves a run's pipeline id against the workspace, ADOPTING a catalog built-in the board was
   * never seeded with (see `pipelines/pipelineAdoption.ts`). This controller's ONLY pipeline read,
   * which is why it no longer takes the repository. Required rather than optional: a reusable
   * operation pins its pipeline by id, so a missing collaborator here does not degrade, it 404s
   * the very runs the pin exists to launch.
   */
  pipelineAdoption: PipelineAdoption
  runStateMachine: RunStateMachine
  workRunner: WorkRunner
  subscriptionActivations?: SubscriptionActivationRepository
  /**
   * The logger the start path reports a POLICY sandbox through: a run held to a dry run by its
   * merge preset is a disposition the initiator did not choose, so it is stated to the operator
   * as well as to the run's own notes.
   */
  logger?: Logger
  /**
   * The roles the task's merge preset forces into dry-run mode, as a BOUND CALLBACK rather than
   * the merge-policy service itself: this controller launches runs and has no other business with
   * merge policy, and the one fact it needs is a list of roles. Absent (a caller with no preset
   * layer wired) sandboxes nobody, which is the shipped default.
   */
  resolveDryRunRoles?: (
    workspaceId: string,
    block: Block,
  ) => Promise<readonly WorkspaceRole[] | undefined>
  requireWorkspace: (workspaceId: string) => Promise<unknown>
  requireBlock: (workspaceId: string, id: string) => Promise<Block>
  failRun: (
    workspaceId: string,
    executionId: string,
    message: string,
    kind?: AgentFailureKind,
    detail?: string | null,
    reason?: string | null,
  ) => Promise<void>
}

/**
 * A run's LIFECYCLE surface: every entry point that launches one (`start`), re-launches one
 * (`retry` / `restartFromStep`), lifts a spend pause (`resumePaused`), or ends one (`cancel` /
 * `stopRun` / `teardownForBlockTree`).
 *
 * They belong together because all three launch paths write the SAME two things in the SAME order:
 * the atomic live-run claim, then the durable/SPA/outbound hand-off (both owned by `runStart.ts`,
 * reached through the one `runStartDeps` getter below). They differ only in the block patch written
 * between the two and in what each tears down first. Keeping that order in one place is what stops
 * a new entry point from claiming without handing off (a run nothing drives) or announcing before
 * the claim commits.
 *
 * `ExecutionService` keeps thin delegates, so no HTTP call site changed. The per-step machine
 * (`advanceInstance` / `stepInstance`) and the human decision surface (`StepDecisionController`)
 * deliberately stay where they are: those act on a run that is already live.
 */
export class RunLifecycleController {
  constructor(private readonly deps: RunLifecycleDeps) {}

  /** Start a pipeline against a block, replacing any prior run on it. */
  async start(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    options: RunStartOptions = {},
  ): Promise<ExecutionInstance> {
    const { initiatedBy, activate, origin = 'manual', intakeOrigin, gatesOverride } = options
    await this.deps.requireWorkspace(workspaceId)
    const block = await this.deps.requireBlock(workspaceId, blockId)
    // Adopts a catalog built-in this board was never seeded with, so a task whose type PINS one
    // (a reusable operation) is runnable on a board older than the operation. `assertFound` still
    // 404s an id that is neither stored nor in the live catalog.
    const pipeline = assertFound(
      await this.deps.pipelineAdoption.adoptForRun(workspaceId, pipelineId),
      'Pipeline',
      pipelineId,
    )

    // Launch-constraint gate (start-only, NOT part of the shared retry re-validation): reject a
    // manual start of a recurring-only pipeline (or a scheduled fire of a one-off-only one), and
    // a bug-intake pipeline that isn't recurring. Before any side effects.
    assertPipelineLaunchable(pipeline.agentKinds, pipeline.availability, origin, pipeline.enabled)

    // Per-run gate override must be parallel to the pipeline's steps (one boolean per step,
    // original-index-aligned like `pipeline.gates`). A mismatch means a preset's review mapping
    // is out of step with the pipeline it targets — reject up front, before any side effects.
    if (gatesOverride && gatesOverride.length !== pipeline.agentKinds.length) {
      throw new ValidationError(
        `Gate override has ${gatesOverride.length} entr${gatesOverride.length === 1 ? 'y' : 'ies'} but pipeline '${pipeline.id}' has ${pipeline.agentKinds.length} step(s).`,
      )
    }

    // Shared config/resource preconditions (pipeline shape, frame type, tester infra, binary
    // storage, agent backend, provider/preset satisfiability, budget) — the SAME gate a retry
    // runs, so the two can't drift. See assertRunnable.
    await this.deps.admission.assertRunnable(workspaceId, block, pipeline, initiatedBy)

    // A Ralph-loop step needs a programmatic completion command (its exit condition); refuse to
    // start a misconfigured run rather than dispatch a validation-less coding pass that never
    // gates. The command is a per-task agent-config value (the SPA also requires it at creation).
    if (
      pipeline.agentKinds.some(isRalphKind) &&
      !resolveRalphConfig(block.agentConfig).validationCommand
    ) {
      throw new ValidationError(
        'A Ralph loop task needs a validation command (its completion criterion) before it can ' +
          'start. Set one in the task configuration.',
      )
    }

    // START-ONLY gates below: a retry REPLACES the failed run rather than adding a new one, so
    // the concurrency limit doesn't apply to it, and a re-drive of an already-started task isn't
    // re-gated on its dependencies.

    // Enforce the workspace's per-service running-task limit (off by default) — a clear,
    // actionable error before any side effects, so the human knows why the start was refused.
    await this.deps.admission.assertWithinTaskLimit(workspaceId, block)

    // Hard dependency gate: a task cannot start while any block it `dependsOn` is unfinished
    // (not yet `done`/merged). Enforced server-side so it holds for manual starts, recurring
    // fires, auto-start propagation and direct API calls alike — the frontend's runnable
    // check is only a hint. Before any side effects so nothing is torn down on a refusal.
    await this.deps.admission.assertDependenciesMet(workspaceId, block)

    // Mint the activation next: if the credential can't be unlocked, fail before
    // tearing down the block's prior run or creating a new one.
    const executionId = this.deps.idGenerator.next('exec')
    await activate?.(executionId)

    // Read the block's prior run once: a manual re-start of an already-running block REPLACES
    // it (the board offers "start" on a live block), so we pass its id to `insertLive` as the
    // `replaceId` it supersedes atomically. A genuinely-CONCURRENT second start reads the SAME
    // prior (or none), so only one insert wins and the other is rejected 409 — the loser's
    // `replaceId` deletes only what it read, never the winner's fresh row (see insertLive).
    const prior = await this.deps.executionRepository.getByBlock(workspaceId, blockId)
    // Replacing the block's prior run: clear its per-run activation now (it never reaches
    // the terminal cleanup in emitInstance when it's still running), so a replaced run's
    // system-encrypted token copy doesn't linger to its TTL. Keyed by the OLD run id, so
    // the activation just minted for the new run is untouched.
    if (this.deps.subscriptionActivations && prior && prior.id !== executionId) {
      // Best-effort + idempotent, mirroring the terminal cleanup in RunStateMachine.emit: a
      // failure here must never derail the start. In mothership mode this repo is remote and
      // `deleteByExecution` is not yet allow-listed (it throws `unknown_method`), so an
      // unguarded call would otherwise break re-running any block; the TTL sweep reclaims the
      // stale activation row as the backstop.
      try {
        await this.deps.subscriptionActivations.deleteByExecution(prior.id)
      } catch {
        // Swallow — see above.
      }
    }

    // NB: do NOT `deleteByBlock` here — `claimLiveRunOrConflict` (below) atomically clears the
    // block's terminal rows AND the `prior` run it replaces, then inserts the new live run, so a
    // concurrent double-start is rejected by the live-run index instead of both wiping each
    // other's row (see insertLive).

    // Build the run only from the ENABLED steps. A step the pipeline marked
    // `enabled[i] === false` is kept in the saved pipeline (so it can be toggled back
    // on later) but skipped here entirely. Gates/thresholds are read by the kind's
    // ORIGINAL index `i`, so they stay aligned to the kind even when earlier steps are
    // skipped; the first SURVIVING step is the one that starts working.
    const steps: PipelineStep[] = pipeline.agentKinds
      .map((kind, i) => ({ kind, i }))
      .filter(({ i }) => pipeline.enabled?.[i] !== false)
      .map(({ kind, i }, position) => {
        const companionDef = companionFor(kind, this.deps.agentKindRegistry)
        return {
          agentKind: kind,
          state: position === 0 ? 'working' : 'pending',
          progress: 0,
          decision: null,
          // A gated step pauses for human approval once its proposal is ready (see
          // recordStepResult). A per-run override (the initiative-preset seam) wins over the
          // pipeline's own gate for this step; else the pipeline definition at run start. Both
          // read by the step's ORIGINAL index `i`, so they stay aligned to the kind even when
          // earlier steps are disabled.
          requiresApproval: gatesOverride?.[i] ?? pipeline.gates?.[i] ?? false,
          approval: null,
          // A consensus-enabled step runs through the multi-model mechanism (the consensus
          // executor reads this off the context). Copied from the pipeline at run start.
          ...(pipeline.consensus?.[i] ? { consensus: pipeline.consensus[i] } : {}),
          // Estimate gating: when set+enabled the step is skipped at runtime unless the
          // block estimate (written by an earlier task-estimator step) meets the threshold.
          ...(pipeline.gating?.[i] ? { gating: pipeline.gating[i] } : {}),
          // The extensible per-step options bag (the new home for per-step parameters — see
          // stepOptionsSchema). Copied from the pipeline at run start, keyed by the step's
          // ORIGINAL index `i`, so it stays aligned to the kind even when earlier steps are
          // disabled. Today it carries the requirements-review `autoRecommend` toggle.
          ...(pipeline.stepOptions?.[i] ? { stepOptions: pipeline.stepOptions[i] } : {}),
          // A companion step carries its quality bar + rework budget, seeded from the
          // pipeline's per-step threshold (else the companion's default).
          ...(companionDef
            ? {
                companion: {
                  threshold: pipeline.thresholds?.[i] ?? companionDef.defaultThreshold,
                  maxAttempts: DEFAULT_COMPANION_MAX_ATTEMPTS,
                  attempts: 0,
                  verdicts: [],
                },
              }
            : {}),
          // The Follow-up companion is on by default for a `coder` step; the pipeline's
          // per-step `followUps[i] === false` toggle disables it. Seeded empty here; the
          // harness streams items in as the Coder surfaces them (see pollAgentJob).
          ...(kind === FOLLOW_UP_PRODUCER_KIND && pipeline.followUps?.[i] !== false
            ? {
                followUps: {
                  enabled: true,
                  items: [],
                  loops: 0,
                  maxLoops: DEFAULT_FOLLOW_UP_MAX_LOOPS,
                },
              }
            : {}),
          // The test quality-control companion is on by default for a Tester step; the
          // pipeline's per-step `testerQuality[i].enabled === false` disables it. `maxAttempts`
          // is seeded with the default ceiling here and refreshed from the task's resolved
          // merge preset on the first report (TesterController). Optional estimate gating is
          // carried through so it can be evaluated against the block estimate at gate time.
          ...(isTesterKind(kind) && pipeline.testerQuality?.[i]?.enabled !== false
            ? {
                testerQuality: {
                  enabled: true,
                  attempts: 0,
                  maxAttempts: DEFAULT_RISK_POLICY.maxTesterQualityIterations,
                  verdicts: [],
                  ...(pipeline.testerQuality?.[i]?.gating
                    ? { gating: pipeline.testerQuality[i]!.gating }
                    : {}),
                },
              }
            : {}),
          // A `ralph` step carries its persistent-loop state — the iteration count, the budget,
          // and the programmatic completion command — seeded from the block's per-task agent
          // config. Riding the persisted step is what lets a mid-loop run survive a restart
          // (both durable drivers + sweepers re-drive from it). See ralph.logic.ts.
          ...(isRalphKind(kind)
            ? { ralph: seedRalphState(resolveRalphConfig(block.agentConfig)) }
            : {}),
        }
      })
    if (steps.length === 0) {
      throw new ValidationError('Pipeline has no enabled steps to run.')
    }
    // For a visual (UI-test) pipeline on a frontend frame, resolve its backend bindings ONCE at
    // start and stamp both the resolved bindings and the non-fatal advisories (duplicate env vars,
    // or a partial-live set of bound services) on the run. The bindings are a frozen snapshot so
    // the SPA's run/step detail projects what the run ACTUALLY drove against (truthful after the
    // envs are torn down). Only paid for a visual pipeline — the same condition the tester infra
    // gate keys off — so a plain backend run does no extra env read. Absent → no notes/bindings.
    const frontendRun = pipelineHasVisualStep({ agentKinds: pipeline.agentKinds })
      ? await this.deps.contextBuilder.resolveFrontendRunInfo(workspaceId, block)
      : undefined
    // Settle the run's MODE once and pin it below. Read at START, never at merge time: a run
    // admitted as live must not become un-mergeable because the preset was edited while it
    // worked, nor a sandboxed one escape because its role was un-listed mid-flight.
    const { mode, notes } = await settleRunModeForStart({
      requested: options.mode,
      role: options.initiatedByRole,
      loadDryRunRoles: async () => await this.deps.resolveDryRunRoles?.(workspaceId, block),
      baseNotes: frontendRun?.notes ?? [],
      logger: this.deps.logger ?? noopLogger,
      fields: { workspaceId, executionId, blockId },
    })
    const instance: ExecutionInstance = {
      id: executionId,
      blockId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps,
      currentStep: 0,
      status: 'running',
      initiatedBy: initiatedBy ?? null,
      // The authority this run is admitted under, pinned for the DURABLE merge path (which
      // rebuilds the run from its stored row and has no request context to re-resolve a role
      // from). Absent stays absent rather than being guessed onto a tier; `mode` is stored only
      // when sandboxed, since `live` is the read-time default and what every legacy run was.
      initiatedByRole: options.initiatedByRole ?? null,
      ...(mode === 'dry_run' ? { mode } : {}),
      // Only a headless start carries an explicit intake origin; `ui` is the read-time
      // default, so an ordinary board/schedule start stores nothing extra.
      ...(intakeOrigin != null ? { intakeOrigin } : {}),
      createdAt: this.deps.clock.now(),
      ...(notes.length ? { notes } : {}),
      ...(frontendRun?.bindings.length ? { frontendBindings: frontendRun.bindings } : {}),
    }
    await claimLiveRunOrConflict(this.runStartDeps, workspaceId, instance, prior?.id)
    await this.deps.blockRepository.update(workspaceId, blockId, {
      status: 'in_progress',
      progress: 0,
      executionId: instance.id,
    })
    await handOffLiveRun(this.runStartDeps, workspaceId, instance, block)
    return instance
  }

  /**
   * Retry a failed run: re-drive the same pipeline on the same block, **resuming
   * from the step that actually failed** rather than restarting from step 0. The
   * steps that already completed are preserved (so a `coder` failure in `pl_full`
   * doesn't re-run the human-gated `requirements`/`architect` steps before it);
   * the failed step and everything after it are reset to a clean, re-runnable
   * state. Only a `failed` run can be retried.
   *
   * A fresh instance id is minted because the durable runner addresses one
   * Workflows instance per execution id and the failed one is terminal — the new
   * instance simply starts with `currentStep` pointed at the failed step, so the
   * driver advances forward from there and never re-issues the completed steps'
   * work. Mirrors {@link BootstrapService.retry}; both are reached via the unified
   * `POST /agent-runs/:id/retry` endpoint.
   */
  async retry(
    workspaceId: string,
    executionId: string,
    /** The retrying user (their personal subscription is used for individual-usage
     *  models). Falls back to the original initiator when omitted. */
    initiatedBy?: string | null,
    /** Mint the per-run personal-credential activation (see {@link start}). */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    const previous = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(
        `Only a failed run can be retried (run is '${previous.status}').`,
        'run_not_retryable',
        { status: previous.status },
      )
    }
    const block = await this.deps.requireBlock(workspaceId, previous.blockId)

    // Run the SAME config/resource preconditions start() does (shape, frame type, tester infra,
    // binary storage, agent backend, provider/preset satisfiability, budget), so a retry can't
    // silently proceed on a config a fresh start would refuse — the drift that let a
    // subscription-only preset fail mid-run against the routing default. Validated over the
    // STORED steps (what the retry actually re-drives), not the current pipeline definition, so
    // an out-of-band pipeline edit can't skew the gate and a deleted pipeline needs no special
    // case. Before any side effects.
    await this.deps.admission.assertRunnable(
      workspaceId,
      block,
      this.deps.admission.runnableShapeOf(previous.steps),
      initiatedBy ?? previous.initiatedBy,
    )

    const { steps, currentStep } = planResumedSteps(previous)
    // Mint the activation before replacing the failed run, so a bad password aborts
    // the retry without losing the retryable terminal run.
    const newId = this.deps.idGenerator.next('exec')
    const replaceId = previous.id
    await activate?.(newId)
    // Replace the terminal failed run for this block with the resumed one (single run per
    // block, matching the board's by-block projection). This mints a FRESH run id; the
    // atomic `claimLiveRunOrConflict` below replaces `previous` (via `replaceId`) and clears
    // any terminal rows in the SAME transaction, so a concurrent double-retry is serialised by
    // the live-run index (the loser gets a 409) instead of both deleting-then-inserting.
    const instance = buildResumedInstance({
      previous,
      id: newId,
      plan: { steps, currentStep },
      initiatedBy,
      now: this.deps.clock.now(),
    })
    await claimLiveRunOrConflict(this.runStartDeps, workspaceId, instance, replaceId)
    const done = steps.filter((s) => s.state === 'done').length
    await this.deps.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await handOffLiveRun(this.runStartDeps, workspaceId, instance, block)
    return instance
  }

  /**
   * Restart a run from a human-chosen step: re-run from `fromStepIndex` onward,
   * regardless of how far the run had progressed (a `done`, `failed`, `blocked`,
   * `paused` or still-`running` run are all valid sources). Unlike {@link retry}
   * (which resumes at the first FAILURE) this rewinds to an arbitrary step the user
   * picked — so it can re-run steps that already completed.
   *
   * What is preserved vs reset:
   * - Steps BEFORE `fromStepIndex` keep their `output`/approval/timing untouched, so
   *   the engine still hands the restarted step its predecessors' work as
   *   `priorOutputs` (and their resolved `decisions`) — a useful handoff.
   * - The chosen step and every later one are reset to a clean, re-runnable state,
   *   dropping each step's iteration counters (companion attempts, gate/test attempts,
   *   eviction recoveries) so the restart starts those loops from zero.
   * - A block's incorporated requirements are NOT touched: they live on the
   *   requirement-review record, so a restarted spec-writer/coder still receives the
   *   incorporated document (or the base description when none was generated). When the
   *   chosen step is the `requirements-review` gate ITSELF, re-running it mints a fresh
   *   iteration-1 review (the reviewer's `review()` replaces the prior one), which is
   *   exactly the "reset the iterations counter from this step" semantics.
   *
   * Like {@link retry} a fresh instance id is minted (the durable runner addresses one
   * driver per execution id). Any still-live driver/container for the run being
   * replaced is torn down first, so restarting a RUNNING run never orphans a container
   * or a parked Workflows instance.
   */
  async restartFromStep(
    workspaceId: string,
    executionId: string,
    fromStepIndex: number,
    /** The restarting user (their personal subscription is used for individual-usage
     *  models). Falls back to the original initiator when omitted. */
    initiatedBy?: string | null,
    /** Mint the per-run personal-credential activation (see {@link start}). */
    activate?: (executionId: string) => Promise<void>,
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    const previous = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const block = await this.deps.requireBlock(workspaceId, previous.blockId)
    if (
      !Number.isInteger(fromStepIndex) ||
      fromStepIndex < 0 ||
      fromStepIndex >= previous.steps.length
    ) {
      throw new ValidationError(
        `Step ${fromStepIndex} is out of range for this run (it has ${previous.steps.length} step(s)).`,
      )
    }

    // Run the SAME config/resource preconditions start()/retry() do, over the STORED steps this
    // restart re-drives (frame type, tester infra, binary storage, agent backend, provider/preset
    // satisfiability, budget). A restart re-dispatches provider-bearing steps just like a retry,
    // so it must be gated identically — otherwise a run whose preset can't run every step (e.g. a
    // subscription-only model an inline reviewer can't drive) strands mid-run instead of being
    // refused up front. Before any teardown/side effects.
    await this.deps.admission.assertRunnable(
      workspaceId,
      block,
      this.deps.admission.runnableShapeOf(previous.steps),
      initiatedBy ?? previous.initiatedBy,
    )

    // Tear down whatever was driving the run we're about to replace — its per-run
    // container AND its durable driver — before minting the restart. A `done`/`failed`
    // run is already terminal (a no-op teardown), but a still-`running` run would
    // otherwise leak a container and a live Workflows/pg-boss driver.
    await this.deps.runStateMachine.stopRunContainer(workspaceId, previous)
    await this.deps.workRunner.cancelRun(workspaceId, executionId)

    const { steps, currentStep } = planRestartFromStep(previous, fromStepIndex)
    // Mint the activation before replacing the prior run, so a bad password aborts the
    // restart without losing the source run.
    const newId = this.deps.idGenerator.next('exec')
    const replaceId = previous.id
    await activate?.(newId)
    // Like retry(), this mints a FRESH run id. `claimLiveRunOrConflict` atomically supersedes
    // the torn-down source run (`replaceId`, which here may still be LIVE — running/paused/
    // blocked) and clears terminal rows in one transaction, so a concurrent start that already
    // created a NEW live run for the block loses (409) instead of being silently clobbered.
    const instance = buildResumedInstance({
      previous,
      id: newId,
      plan: { steps, currentStep },
      initiatedBy,
      now: this.deps.clock.now(),
    })
    await claimLiveRunOrConflict(this.runStartDeps, workspaceId, instance, replaceId)
    const done = steps.filter((s) => s.state === 'done').length
    await this.deps.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await handOffLiveRun(this.runStartDeps, workspaceId, instance, block)
    return instance
  }

  /**
   * The bound callbacks the two run-start funnels (`runStart.ts`) need, so they depend on no
   * concrete repository or service. Those funnels own the ORDER between a run's atomic claim and
   * its hand-off and are documented there; every start path calls both, writing the block state
   * that path owns in between.
   */
  private get runStartDeps(): RunStartDeps {
    return {
      insertLive: (ws, instance, options) =>
        this.deps.executionRepository.insertLive(ws, instance, options),
      startRun: (ws, id) => this.deps.workRunner.startRun(ws, id),
      emitInstance: (ws, instance) => this.deps.runStateMachine.emitInstance(ws, instance),
      publishRunStarted: (ws, instance, block) =>
        this.deps.runStateMachine.publishRunStarted(ws, instance, block),
    }
  }

  /**
   * Resume every run paused by the spend safeguard in this workspace. Flips them
   * back to `running` and re-drives the durable runner. If the budget is still
   * exhausted the spend gate will simply pause them again on their next step.
   */
  async resumePaused(workspaceId: string): Promise<ExecutionInstance[]> {
    await this.deps.requireWorkspace(workspaceId)
    // Lean projection: only the paused runs' ids are needed to re-drive them — no `detail` decode.
    const live = await this.deps.executionRepository.listLive(workspaceId)
    const paused = live.filter((e) => e.status === 'paused')
    for (const p of paused) {
      // Optimistic-concurrency write: only flip + re-drive a run that is STILL paused at
      // write time, so a resume racing the driver (or a concurrent resume) can't clobber a
      // run another writer already advanced. A vanished/contended run is skipped (the next
      // sweep retries) rather than failing the whole batch.
      let flipped = false
      const resumed = await this.deps.runStateMachine
        .mutateInstance(workspaceId, p.id, (inst) => {
          flipped = inst.status === 'paused'
          if (flipped) inst.status = 'running'
        })
        .catch(() => null)
      if (resumed && flipped) {
        // `startRun` re-drives runners that re-create the run from scratch (pg-boss re-enqueues
        // the same id). On Cloudflare the paused run's Workflows instance is still ALIVE parked
        // on a `waitForEvent`, so `startRun`'s `create` no-ops there; `signalResume` delivers the
        // event that wakes it immediately instead of waiting out the periodic budget re-check.
        await this.deps.workRunner.startRun(workspaceId, resumed.id)
        await this.deps.workRunner.signalResume?.(workspaceId, resumed.id)
        await this.deps.runStateMachine.emitInstance(workspaceId, resumed)
      }
    }
    // Clear the workspace-scoped `budget_paused` card now the pause is being lifted (F3). If the
    // budget is still exhausted a resumed run re-pauses and re-raises it on its next step.
    await this.deps.runStateMachine.clearBudgetPaused(workspaceId)
    return this.deps.executionRepository.listByWorkspace(workspaceId)
  }

  /** Cancel the run on a block, returning it to `planned`. */
  async cancel(workspaceId: string, blockId: string): Promise<Block> {
    await this.deps.requireWorkspace(workspaceId)
    await this.deps.requireBlock(workspaceId, blockId)
    // Tear down the durable run (if any) AND its per-run container before removing
    // the record, so a cancel never leaves a container running until its watchdog.
    const existing = await this.deps.executionRepository.getByBlock(workspaceId, blockId)
    if (existing) {
      await this.deps.runStateMachine.stopRunContainer(workspaceId, existing)
      await this.deps.workRunner.cancelRun(workspaceId, existing.id)
    }
    await this.deps.executionRepository.deleteByBlock(workspaceId, blockId)
    await this.deps.blockRepository.update(workspaceId, blockId, {
      status: 'planned',
      progress: 0,
      executionId: null,
    })
    // The run record is gone and the block is back to planned; the client can't reconstruct that
    // from a per-instance event (there is no instance left to emit one). Carry the reset block so
    // every board mounting its shared service patches it instead of re-reading a snapshot. A
    // cancelled public-API run's HEADLESS anchor block is refused at the wire by
    // `deliverableBoardBlock` (the twin of the check `RunStateMachine.emitInstance` makes), so it
    // degrades to a coarse signal here rather than pushing a card no board may show.
    const block = await this.deps.requireBlock(workspaceId, blockId)
    await this.deps.events.boardChanged(workspaceId, { reason: 'cancel', block })
    return block
  }

  /**
   * Explicitly stop a *running* run by id (the unified `POST /agent-runs/:id/stop`
   * surface): kill its per-run container, tear down the durable driver, then record
   * a terminal `cancelled` failure so the board shows the run stopped (with retry)
   * rather than spinning forever. Idempotent — a run already terminal is returned
   * as-is. `opts.reason`/`opts.kind` let the orphan sweep reuse this with its own
   * wording instead of the user-facing default.
   */
  async stopRun(
    workspaceId: string,
    executionId: string,
    opts: { reason?: string; kind?: AgentFailureKind } = {},
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (instance.status === 'failed' || instance.status === 'done') return instance
    await this.deps.runStateMachine.stopRunContainer(workspaceId, instance)
    await this.deps.workRunner.cancelRun(workspaceId, executionId)
    await this.deps.failRun(
      workspaceId,
      executionId,
      opts.reason ?? 'Stopped by the user.',
      opts.kind ?? 'cancelled',
    )
    return assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /**
   * Tear down every run under a block subtree — kill each container, terminate each
   * durable driver, and delete the run record — so deleting a service/module never
   * orphans a container or a Workflows instance. Best-effort and silent: the board
   * delete that follows emits the coarse refresh, so no per-run event is needed.
   *
   * Returns the workspace block list it loaded so the immediately-following `removeBlock`
   * can reuse it instead of re-listing the whole board (this teardown deletes only run
   * records, never blocks, so the list is still current) — see {@link PreloadedBlocks}.
   */
  async teardownForBlockTree(workspaceId: string, rootId: string): Promise<PreloadedBlocks> {
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    // Resolve every run in one query and index by block id, rather than a per-block
    // getByBlock (N+1) over the whole subtree.
    const runsByBlock = new Map(
      (await this.deps.executionRepository.listByWorkspace(workspaceId)).map((run) => [
        run.blockId,
        run,
      ]),
    )
    for (const blockId of descendantIds(blocks, rootId)) {
      const run = runsByBlock.get(blockId)
      if (!run) continue
      await this.deps.runStateMachine.stopRunContainer(workspaceId, run)
      await this.deps.workRunner.cancelRun(workspaceId, run.id)
      await this.deps.executionRepository.deleteByBlock(workspaceId, blockId)
    }
    return { workspaceId, blocks }
  }
}
