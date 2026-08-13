import type {
  BinaryGeneratorSource,
  Block,
  BlockRepository,
  ExecutionRepository,
  ModelRef,
  PipelineStep,
  ProviderCapabilities,
  ResolveBinaryArtifactStore,
  StepOptions,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  ConflictError,
  type ConnectionTestResult,
  declaredModelRouteLabels,
  isAllowedByFamilyPolicy,
  isModelUsable,
  isModelUsableInline,
  resolveModelRef,
  subscriptionOptionFor,
} from '@cat-factory/kernel'
import {
  frameAllowsVisualPipeline,
  frameProfile,
  isHarnessTransport,
  isLocalRunner,
  pipelineHasVisualStep,
  stepConditionSatisfied,
} from '@cat-factory/contracts'
import {
  BINARY_OUTPUT_TRAIT,
  BINARY_STORAGE_TRAIT,
  hasTrait,
  isInlineModelStep,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { GateRegistry } from '@cat-factory/kernel'
import type { BinaryGeneratorSelectionIssue } from '@cat-factory/kernel'
import {
  binaryGeneratorSelectionIssues,
  binaryOutputConfigIssues,
  describeBinaryGeneratorSelectionIssues,
  describeBinaryOutputConfigIssues,
} from '@cat-factory/kernel'
import type { FoundationalServiceResolver } from './run-foundational-services.js'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import type { SpendService } from '@cat-factory/spend'
import { validatePipelineShape, type PipelineShape } from '../pipelines/pipelineShape.js'
import { assertInitiativeShapeAllowed } from '../initiative/initiative.logic.js'
import { isTesterKind } from './ci.logic.js'
import { chainHasConditionalStep, resolveScopeForRun } from './runServiceScope.js'
import {
  CONSUMER_ENVIRONMENT_FAULT_MESSAGES,
  consumerEnvironmentFault,
  decideTesterInfra,
  ENV_CONSUMER_KINDS,
  TESTER_INFRA_MESSAGES,
} from './tester-infra.logic.js'
import {
  decideDeployerConfig,
  deployerServiceConfigIssues,
  hasEnabledDeployerStep,
} from './deployer.logic.js'
import { hasLiveServiceBinding, hasServiceBinding } from './frontend-infra.logic.js'
import { dependenciesMet, unmetDependencies } from '../board/board.logic.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { WorkspaceSettingsService } from '../settings/WorkspaceSettingsService.js'

/** Collaborators + optional facade seams the admission preflights read. */
export interface RunAdmissionDeps {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  contextBuilder: AgentContextBuilder
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned gate registry, so a step's gate PARAMETERS are re-validated at run start against
   * the fields the gate declared — the same check the builder makes at save. Required (not
   * optional like the seams below) for the reason `agentKindRegistry` is: the two boundaries
   * answering from different registries is how a pipeline passes one and is refused by the other.
   */
  gateRegistry: GateRegistry
  spend: SpendService
  /** Optional — see the matching {@link ExecutionServiceDependencies} docs; each guard is a
   *  pass-through when its seam is unwired (tests / unconfigured facades). */
  environmentProvisioning?: EnvironmentProvisioningService
  workspaceSettingsService?: WorkspaceSettingsService
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * The foundational-services catalog seam, for validating a binary-generating step's
   * storage/context selection against the RESOLVED catalog. Absent ⇒ the selection cannot be
   * checked here (the presence check still runs), and the dispatch-time brief states whatever
   * gap remains to the agent — matching the other optional start guards.
   */
  foundationalServiceResolver?: FoundationalServiceResolver
  /**
   * The deployment's GENERATIVE BINARY INTEGRATIONS, for validating a binary-generating step's
   * `generatorIds` + declared content types. Optional so a test constructing this class by hand
   * keeps the guard as a pass-through; a facade always resolves one. On a mothership-mode node
   * it is REMOTE, which is what makes this check resolve against the same set the pipeline
   * builder offered rather than against whatever this node's build happens to hold.
   */
  binaryGeneratorSource?: BinaryGeneratorSource
  resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
    modelPresetId?: string,
  ) => Promise<ProviderCapabilities>
  inlineHarnessRef?: (ref: ModelRef) => boolean
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  assertAgentBackendConfigured?: (workspaceId: string) => Promise<void>
}

/**
 * The run ADMISSION preflights — every config/resource precondition a run must satisfy
 * before it is allowed to START, RETRY or RESTART, extracted out of `ExecutionService`
 * so the engine's public lifecycle methods stay readable while the guard family grows.
 * All checks are read-only and run BEFORE any side effects, each throwing an actionable
 * {@link ConflictError}. The shared entry point is {@link assertRunnable}; the start-only
 * concurrency/dependency gates ({@link assertWithinTaskLimit}, {@link assertDependenciesMet})
 * are separate because a retry/restart deliberately skips them.
 */
export class RunAdmission {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly executionRepository: ExecutionRepository
  private readonly contextBuilder: AgentContextBuilder
  private readonly agentKindRegistry: AgentKindRegistry
  private readonly gateRegistry: GateRegistry
  private readonly spend: SpendService
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly workspaceSettingsService?: WorkspaceSettingsService
  private readonly resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  private readonly foundationalServiceResolver?: FoundationalServiceResolver
  private readonly binaryGeneratorSource?: BinaryGeneratorSource
  private readonly resolveProviderCapabilities?: (
    workspaceId: string,
    initiatedBy?: string | null,
    modelPresetId?: string,
  ) => Promise<ProviderCapabilities>
  private readonly inlineHarnessRef?: (ref: ModelRef) => boolean
  private readonly resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  private readonly assertAgentBackendConfigured?: (workspaceId: string) => Promise<void>

  constructor(deps: RunAdmissionDeps) {
    this.workspaceRepository = deps.workspaceRepository
    this.blockRepository = deps.blockRepository
    this.executionRepository = deps.executionRepository
    this.contextBuilder = deps.contextBuilder
    this.agentKindRegistry = deps.agentKindRegistry
    this.gateRegistry = deps.gateRegistry
    this.spend = deps.spend
    this.environmentProvisioning = deps.environmentProvisioning
    this.workspaceSettingsService = deps.workspaceSettingsService
    this.resolveBinaryArtifactStore = deps.resolveBinaryArtifactStore
    this.foundationalServiceResolver = deps.foundationalServiceResolver
    this.binaryGeneratorSource = deps.binaryGeneratorSource
    this.resolveProviderCapabilities = deps.resolveProviderCapabilities
    this.inlineHarnessRef = deps.inlineHarnessRef
    this.resolveWorkspaceModelDefault = deps.resolveWorkspaceModelDefault
    this.assertAgentBackendConfigured = deps.assertAgentBackendConfigured
  }

  /**
   * The config/resource preconditions a run must satisfy to START, RETRY **or** RESTART:
   * everything that depends on the workspace environment + the steps being run, and NOT on
   * whether this is a fresh run or a replacement. All three entry points call this so they
   * can't drift — a guard added to one but silently missing from the other is exactly how a
   * subscription-only preset slipped past retry and failed mid-run against the routing default.
   * All checks are read-only and run BEFORE any side effects, each throwing an actionable
   * {@link ConflictError}.
   *
   * The `shape` is the effective chain that will run, NOT the current pipeline definition: a
   * fresh start passes the pipeline, while a retry/restart passes the STORED steps (via
   * {@link runnableShapeOf}) so the guard validates exactly what re-executes — a pipeline
   * edited out of band since the run started can't falsely refuse (or silently skip a check
   * for) a step that isn't actually being re-driven.
   *
   * The concurrency (task-limit) and dependency gates are deliberately NOT here — they are
   * start-only (a retry replaces the failed run rather than adding a new concurrent one, and a
   * re-drive of an already-started task isn't re-gated on its dependencies).
   */
  async assertRunnable(
    workspaceId: string,
    block: Block,
    shape: PipelineShape,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    // Reject a structurally-invalid chain (a misplaced companion, or estimate-gating on a kind
    // that may not be skipped / without a preceding task-estimator). The builder also rejects
    // these at save, but a pipeline can become invalid out of band. The agent-kind registry rides
    // along so a DEPLOYMENT-registered kind's own `gatable` flag is honoured here exactly as it is
    // at save — without it, a registered gatable kind would pass the builder and be refused here.
    // The gate registry rides along for the same reason, so a step's gate parameters are judged
    // against the same declaration at both doors.
    validatePipelineShape({
      ...shape,
      agentKindRegistry: this.agentKindRegistry,
      gateRegistry: this.gateRegistry,
    })

    // The Initiative Planning kinds run ONLY on an `initiative`-level block, and an
    // initiative block accepts ONLY such a chain — bidirectional, and here in the shared
    // guard so start/retry/restart can't drift on it.
    assertInitiativeShapeAllowed(block, shape.agentKinds)

    // Every gate below judges what will ACTUALLY run, so the steps this run's service scope
    // conditions out are dropped first. Without this, one preset carrying both testers would be
    // refused on every backend service — the `tester-ui` step it is never going to dispatch would
    // demand a frontend to drive and an artifact store to upload screenshots to.
    const { activeKinds, enabled } = await this.applyRunConditions(workspaceId, block, shape)

    // A chain with visual steps (`tester-ui` / `visual-confirmation`) needs a UI to exercise:
    // it can only run on a `frontend` frame or a frame a frontend links to — else a `tester-ui`
    // step has no app to drive.
    await this.assertPipelineFrameTypeAllowed(workspaceId, block, activeKinds)

    // A chain with a Tester needs the service's declared provisioning to be runnable
    // (`infraless`/none = no infra; `docker-compose`/`kubernetes`/`custom` = a workspace handler).
    if (activeKinds.some(isTesterKind)) {
      await this.assertTesterInfraConfigured(workspaceId, block, initiatedBy)
    }

    // A `docker-compose`/`kubernetes`/`custom` service whose enabled chain reaches an env-consumer
    // (tester / human-test / playwright) with NO enabled `deployer` before it would dead-end inside
    // the consumer — nothing provisions the environment it reads. Fail fast with an actionable error.
    await this.assertDeployerBeforeConsumer(workspaceId, block, shape.agentKinds, enabled)

    // A chain that INCLUDES an enabled Deployer needs the service's provisioning config (the
    // "what/where") AND the workspace's infra handler (the "how") complete + correct — and, best
    // effort, the deployment integration's live connection working — so a misconfigured environment
    // fails loudly here with a fix-it pointer instead of an async failed env (or a silent no-op).
    await this.assertDeployerConfigured(workspaceId, block, shape.agentKinds, enabled, initiatedBy)

    // A chain carrying an agent that relies on binary-artifact storage (the UI Tester uploads
    // screenshots) needs the account to have storage configured.
    await this.assertBinaryStorageConfigured(workspaceId, activeKinds)

    // A chain carrying a BINARY-GENERATING step (the `binary-output` trait — a deployment's
    // image generator) needs each such step's selection to resolve: its foundational-service
    // half against the workspace catalog, or the generator dispatches with nowhere to deliver
    // its output; its GENERATIVE half against the deployment's integration registry, or it
    // dispatches with nothing to make the output WITH. (The selection's PRESENCE is a structural
    // fault validatePipelineShape refused above.)
    await this.assertBinaryOutputSelected(
      workspaceId,
      block,
      shape.agentKinds,
      shape.stepOptions,
      enabled,
      initiatedBy,
    )

    // A workspace that delegates container agents to a runner pool needs that pool registered
    // (local mode opt-in). No-op on Cloudflare/Node (fixed backend) and when delegation is off.
    await this.assertAgentBackendConfigured?.(workspaceId)

    // Every step's canonical model must have a usable provider — a container step needs any
    // usable flavour, an INLINE step needs an inline-usable one (a subscription-only model can't
    // run inline without an inline harness). This is the gate a retry used to skip.
    await this.assertProvidersConfiguredForPipeline(workspaceId, block, activeKinds, initiatedBy)

    // Refuse a metered run once the spend budget is reached (a clear error rather than a silent
    // mid-run pause). A local/subscription-only pipeline is exempt.
    await this.assertBudgetAllowsPipeline(workspaceId, block, activeKinds, initiatedBy)
  }

  /**
   * Narrow a chain to the steps this run's SERVICE SCOPE admits: the enabled flags with every
   * condition-excluded index turned off, and the kinds that survive both.
   *
   * The flags stay index-aligned (they are read by the ORIGINAL index everywhere) while the kind
   * list is compacted, which is exactly how each downstream gate wants its input. A chain with no
   * conditional step short-circuits before the block-list read, so the overwhelming majority of
   * runs pay nothing for this.
   *
   * The verdict here is ADVISORY in one direction only: it can excuse a step from a gate, never
   * add one. The engine re-evaluates each condition at the step's own turn (`runStepPreamble`),
   * which is the decision that actually skips it; this exists so admission does not refuse a run
   * over a step it can already tell will never dispatch.
   */
  private async applyRunConditions(
    workspaceId: string,
    block: Block,
    shape: PipelineShape,
  ): Promise<{ activeKinds: string[]; enabled: boolean[] | undefined }> {
    const isEnabled = (i: number) => shape.enabled?.[i] !== false
    if (!chainHasConditionalStep(shape.stepOptions)) {
      return {
        activeKinds: shape.agentKinds.filter((_, i) => isEnabled(i)),
        enabled: shape.enabled,
      }
    }
    const scope = await resolveScopeForRun(
      (id) => this.blockRepository.listByWorkspace(id),
      workspaceId,
      block,
    )
    const admits = (i: number) =>
      isEnabled(i) && stepConditionSatisfied(shape.stepOptions?.[i]?.condition, scope)
    return {
      activeKinds: shape.agentKinds.filter((_, i) => admits(i)),
      enabled: shape.agentKinds.map((_, i) => admits(i)),
    }
  }

  /**
   * The {@link PipelineShape} a retry/restart re-drives: the stored run's steps ARE the enabled,
   * ordered chain that will run again, so {@link assertRunnable} validates exactly what
   * re-executes rather than the current pipeline definition (which may have been edited out of
   * band since the run started). Disabled steps were already filtered out at start, so every
   * stored step is enabled.
   */
  runnableShapeOf(steps: readonly PipelineStep[]): PipelineShape {
    return {
      agentKinds: steps.map((s) => s.agentKind),
      // The per-step form of the pipeline's `gates[i]`, copied onto the run step at start. Read by
      // the gating validation to refuse a step carrying both a human gate and an estimate gate, so
      // a retry re-checks that against exactly what re-executes.
      gates: steps.map((s) => s.requiresApproval === true),
      gating: steps.map((s) => s.gating ?? null),
      // The QC companion's live step-state carries the same `gating` config the pipeline set, so
      // the tester-QC gating validation re-runs on a retry against exactly what re-executes.
      testerQuality: steps.map((s) => s.testerQuality ?? null),
      // The per-step options bag (a `skill` step's `skillId`, a step's picked agent-kind variant)
      // is copied onto the run step at start, so the skill-step and variant validations re-run on
      // retry against what re-executes — which is how a retry after the deployment withdrew a
      // variant is refused rather than quietly running the shipped prompt.
      stepOptions: steps.map((s) => s.stepOptions ?? null),
    }
  }

  /**
   * Refuse a task start while any of its dependencies is unfinished. A task may only run
   * once every block it `dependsOn` has reached `done` (its PR merged). No-ops for
   * non-task blocks and for tasks with no dependencies. Throws a {@link ConflictError}
   * (→ 409, shown as a toast) naming the unfinished blockers so the human knows why.
   */
  async assertDependenciesMet(workspaceId: string, block: Block): Promise<void> {
    if (block.level !== 'task' || block.dependsOn.length === 0) return
    const blocks = await this.augmentWithCrossWorkspaceDeps(
      await this.blockRepository.listByWorkspace(workspaceId),
      block.dependsOn,
    )
    if (dependenciesMet(blocks, block.id)) return
    const blockers = unmetDependencies(blocks, block.id)
    const names = blockers.map((b) => `"${b.title}"`).join(', ')
    throw new ConflictError(
      `This task is blocked by ${blockers.length} unfinished dependenc${
        blockers.length === 1 ? 'y' : 'ies'
      }${names ? ` (${names})` : ''}. Finish them before starting this task.`,
      'dependencies_unmet',
      { count: blockers.length, blockers: blockers.map((b) => b.title) },
    )
  }

  /**
   * Augment a workspace's block list (in place) with any dependency blocks referenced by
   * `depIds` that aren't already present — a `dependsOn` edge can point at a task homed in a
   * DIFFERENT workspace (a shared/mounted service). Resolved via the cross-workspace
   * {@link BlockRepository.findByIds} (one batched query, not a point-read per id), so a
   * shared-service blocker is evaluated by its real status instead of being silently treated
   * as satisfied (missing ⇒ done). Returns the same (now-augmented) array for chaining.
   */
  async augmentWithCrossWorkspaceDeps(blocks: Block[], depIds: string[]): Promise<Block[]> {
    const have = new Set(blocks.map((b) => b.id))
    const missing = [...new Set(depIds)].filter((id) => !have.has(id))
    if (missing.length === 0) return blocks
    for (const found of await this.blockRepository.findByIds(missing)) {
      blocks.push(found.block)
    }
    return blocks
  }

  /**
   * Enforce the workspace's per-service running-task limit before a task run starts.
   * No-ops unless the settings module is wired, the block is a task, and a limit mode
   * is active. Counts the tasks under the same service frame that already have a live
   * run (running / blocked / paused) — bucketed by task type when the mode is
   * `per_type`, else shared across all types — and throws a {@link ConflictError} (→ 409,
   * shown as a toast) when the cap is reached. The starting block is excluded from the
   * count (its prior run is about to be replaced).
   */
  async assertWithinTaskLimit(workspaceId: string, block: Block): Promise<void> {
    const settingsService = this.workspaceSettingsService
    if (!settingsService || block.level !== 'task') return
    const settings = await settingsService.get(workspaceId)
    if (settings.taskLimitMode === 'off') return

    const all = await this.blockRepository.listByWorkspace(workspaceId)
    const byId = new Map(all.map((b) => [b.id, b]))
    // Walk up to the owning service frame.
    let frame: Block | undefined = block
    let guard = 0
    while (frame && frame.level !== 'frame' && guard++ < 1000) {
      frame = frame.parentId ? byId.get(frame.parentId) : undefined
    }
    if (!frame || frame.level !== 'frame') return // orphan task — nothing to scope a service limit to
    const frameId = frame.id

    const underFrame = (b: Block): boolean => {
      let cur: Block | undefined = b
      let hops = 0
      while (cur && hops++ < 1000) {
        if (cur.id === frameId) return true
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return false
    }

    // Lean projection of the workspace's live runs (block + status only) — avoids loading and
    // JSON-decoding every historical run's `detail` just to read the handful of live block ids.
    const live = await this.executionRepository.listLive(workspaceId)
    const liveBlockIds = new Set(live.map((e) => e.blockId))
    const siblingTasks = all.filter((b) => b.level === 'task' && b.id !== block.id && underFrame(b))

    if (settings.taskLimitMode === 'shared') {
      const limit = settings.taskLimitShared ?? 0
      const running = siblingTasks.filter((b) => liveBlockIds.has(b.id)).length
      if (running >= limit) {
        throw new ConflictError(
          `"${frame.title}" is already running ${running} of ${limit} allowed task(s). ` +
            `Wait for one to finish before starting another.`,
          'task_limit_reached',
          { frame: frame.title, limit, running },
        )
      }
      return
    }

    // per_type: only the configured types are capped; an unconfigured type is unbounded.
    const type = block.taskType ?? 'feature'
    const perType = (settings.taskLimitPerType ?? {}) as Record<string, number>
    const limit = perType[type]
    if (limit == null) return
    const running = siblingTasks.filter(
      (b) => liveBlockIds.has(b.id) && (b.taskType ?? 'feature') === type,
    ).length
    if (running >= limit) {
      throw new ConflictError(
        `"${frame.title}" is already running ${running} of ${limit} allowed ${type} task(s). ` +
          `Wait for one to finish before starting another ${type} task.`,
        'task_limit_reached',
        { frame: frame.title, limit, running, taskType: type },
      )
    }
  }

  /**
   * Whether a model id will incur metered monetary cost for THIS workspace. Non-metered:
   * a subscription model whose vendor is connected ("subscriptions always win"), or a
   * local-runner model (keyless, on the user's own endpoint). Everything else — including
   * env-default routing (an absent id) and Cloudflare Workers AI — is treated as metered.
   * Shared with {@link RunDispatcher.currentStepIsNonMetered} so the up-front budget gate
   * and the mid-run spend gate can't classify a model differently.
   */
  modelIdIsMetered(id: string | undefined, caps: ProviderCapabilities): boolean {
    const sub = subscriptionOptionFor(id)
    if (sub && caps.subscriptionVendors.has(sub.vendor)) return false
    const ref = resolveModelRef(id, caps)
    if (!ref) return true
    if (ref.harness === 'claude-code' || ref.harness === 'codex') return false
    return !isLocalRunner(ref.provider)
  }

  /**
   * Guard a run start when the pipeline carries a VISUAL step (`tester-ui` /
   * `visual-confirmation`): such a step exercises a rendered UI, so it only makes sense where
   * there is a UI to drive — a `type: 'frontend'` frame (it owns the app under test) or a frame
   * a `frontend` frame links to (the linked frontend is the UI a change to that service is
   * validated through). On any other frame (a service with no linked frontend, a `library` /
   * `document` repo) a `tester-ui` step would have nothing to drive, so refuse the start with an
   * actionable {@link ConflictError} (`visual_pipeline_no_frontend`). The frontend surfaces the
   * SAME rule (via the shared `frameAllowsVisualPipeline`) so it only offers these pipelines
   * where they can run; this is the server-side guarantee. A non-visual pipeline passes through.
   * The workspace block list is read ONCE (for the frontend→service links), never per-frame.
   */
  private async assertPipelineFrameTypeAllowed(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
  ): Promise<void> {
    if (!pipelineHasVisualStep({ agentKinds: [...agentKinds] })) return
    const frame = await this.contextBuilder.resolveServiceFrame(workspaceId, block.id)
    // A `frontend` frame is always allowed without listing the workspace; only a non-frontend
    // frame needs the link scan, so defer the (single) block-list read until then.
    if (frame?.type === 'frontend') return
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    if (frameAllowsVisualPipeline(frame, blocks)) return
    throw new ConflictError(
      'This pipeline includes a UI-testing step, so it can only run on a frontend service (or a ' +
        'backend service that has a frontend linked to it). Move the task under a frontend, link ' +
        'a frontend to this service, or pick a pipeline without UI-testing steps.',
      'visual_pipeline_no_frontend',
      { frameType: frame?.type ?? null },
    )
  }

  /**
   * Guard a Tester pipeline's start on the service frame's declared provisioning being runnable.
   * The Tester needs SOME way to stand its system up: `infraless` (or none declared) runs with no
   * infra; `docker-compose`/`kubernetes`/`custom` are all provisioned by the single Deployer step
   * through a workspace handler, so one must resolve for the service's type. A `frontend` frame is
   * gated instead on having a live service under test. Throws an actionable {@link ConflictError}
   * (`tester_infra_unsupported` for the frontend case, `provision_type_unhandled` for a missing
   * handler); passes through when the provisioning seam is unwired (tests / no environment
   * integration), like the other optional start guards. `initiatedBy` is threaded into
   * `canProvision` so the run initiator's local per-user handler OVERRIDES resolve exactly as they
   * do at provision time (and as the Deployer-config gate does) — else a valid override-only local
   * setup would be falsely refused here while the deployer would actually provision it.
   */
  private async assertTesterInfraConfigured(
    workspaceId: string,
    block: Block,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    // A `frontend` frame (the self-contained UI-test flow) is gated on having a live service
    // under test, NOT on a provision type — resolved first and short-circuiting the backend
    // branch. Only enforce it when the environment seam is wired (else, like the other optional
    // start guards, pass through so tests / no-env deployments run unchanged).
    const frontend = await this.contextBuilder.resolveFrontendConfig(workspaceId, block)
    if (frontend) {
      if (!this.environmentProvisioning) return
      const decision = decideTesterInfra({
        frontend: {
          hasServiceBindings: hasServiceBinding(frontend.config),
          hasLiveService: hasLiveServiceBinding(frontend.bindings),
        },
        provisionType: undefined,
        handlerResolves: true,
      })
      if (decision.ok) return
      throw new ConflictError(TESTER_INFRA_MESSAGES[decision.reason], 'tester_infra_unsupported', {
        infraReason: decision.reason,
      })
    }
    const service = await this.contextBuilder.resolveServiceConfig(workspaceId, block)
    // A `library` frame (not `liveTestable`) runs its unit/integration suite IN-CONTAINER — any
    // repo-local docker-compose is test infra stood up on localhost, never a Deployer-provisioned
    // env — so the tester never needs a workspace handler. Pass through regardless of provisioning.
    if (service?.type && !frameProfile(service.type).liveTestable) return
    const provisioning = service?.provisioning
    // `docker-compose`/`kubernetes`/`custom` are all provisioned by the Deployer via a workspace
    // handler, so resolve it lazily — and only when the provisioning seam is wired (else pass
    // through, treating it as resolvable). `infraless`/none needs no handler.
    const needsHandler =
      provisioning?.type === 'docker-compose' ||
      provisioning?.type === 'kubernetes' ||
      provisioning?.type === 'custom'
    const handlerResolves =
      needsHandler && this.environmentProvisioning
        ? (await this.environmentProvisioning.canProvision(workspaceId, provisioning, initiatedBy))
            .ok
        : true
    const decision = decideTesterInfra({ provisionType: provisioning?.type, handlerResolves })
    if (decision.ok) return
    // The only backend-branch refusal is a provision type with no resolvable handler.
    throw new ConflictError(TESTER_INFRA_MESSAGES[decision.reason], 'provision_type_unhandled', {
      provisionType: provisioning!.type,
    })
  }

  /**
   * Fail fast when a `docker-compose`/`kubernetes`/`custom` service's chain would dead-end at an
   * env-consumer (tester / human-test / playwright) that has no LIVE environment to read: either
   * nothing provisioned one before it, or the `disposer` reclaimed it first. The exact silent
   * dead-end this initiative fixes (the tester picks ephemeral mode from the provision type but
   * finds no coordinates), and both directions of it, because a chain can starve its consumer from
   * either side.
   *
   * The pure ordering check lives in {@link consumerEnvironmentFault}, which defers to the ONE
   * shared rule in contracts; here we resolve the service's provision type (only when a consumer is
   * present, so consumer-less chains skip the read) and translate a returned fault into an
   * actionable {@link ConflictError}. Pass-through for infraless/frontend services and for chains
   * whose consumers each run against something.
   *
   * The `reason` stays `deployer_required_before_tester` across both faults: it is the STATUS-class
   * vocabulary the SPA maps to remedy copy, and both faults have the same remedy surface (the
   * pipeline builder). Which one it is rides in `details.fault`.
   */
  private async assertDeployerBeforeConsumer(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    enabled: readonly boolean[] | undefined,
  ): Promise<void> {
    const hasConsumer = agentKinds.some(
      (kind, i) => enabled?.[i] !== false && ENV_CONSUMER_KINDS.includes(kind),
    )
    if (!hasConsumer) return
    const service = await this.contextBuilder.resolveServiceConfig(workspaceId, block)
    // A `library` frame stands nothing up via the Deployer (its tester runs the suite in-container),
    // so a missing Deployer before the tester is never a dead-end — pass through like `infraless`.
    if (service?.type && !frameProfile(service.type).deployable) return
    const provisionType = service?.provisioning?.type
    const fault = consumerEnvironmentFault(agentKinds, enabled, provisionType)
    if (!fault) return
    throw new ConflictError(
      CONSUMER_ENVIRONMENT_FAULT_MESSAGES[fault.reason](fault.agentKind, provisionType!),
      'deployer_required_before_tester',
      { provisionType: provisionType!, fault: fault.reason, stepIndex: fault.index },
    )
  }

  /**
   * Guard a pipeline that INCLUDES an enabled `deployer` step on its ephemeral-environment config
   * being FULL + CORRECT on BOTH sides of the "what/where ÷ how" split, so a misconfigured
   * environment fails LOUDLY at start with a fixable pointer instead of mid-run: a `kubernetes` /
   * `custom` service silently failing its async provision, or a `docker-compose` one whose deployer
   * NO-OPS because no handler resolves (the exact silent dead-ends this initiative closes). It
   * checks, in order of the fix a human would make:
   *   1. the SERVICE's provisioning config is complete for its declared type (manifest source /
   *      compose path / custom-manifest id) — else `deployer_service_provisioning_incomplete`;
   *   2. a WORKSPACE handler resolves for the type — else `provision_type_unhandled` (the same
   *      reason the Tester gate raises; a MISSING/ambiguous handler, not a broken one);
   *   3. (bonus, best-effort) the resolved deployment integration's live connection PROBES green —
   *      else `deployer_connection_test_failed`, carrying the provider's failure detail.
   * Each `ConflictError` carries a machine-readable reason + details the SPA deep-links off to the
   * exact fix surface. Pass-through for `infraless`/undeclared services (the deployer stands nothing
   * up) and when the environment seam is unwired (tests / no-env deployments), like the other
   * optional start guards.
   */
  private async assertDeployerConfigured(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    enabled: readonly boolean[] | undefined,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!this.environmentProvisioning) return
    if (!hasEnabledDeployerStep(agentKinds, enabled)) return
    const service = await this.contextBuilder.resolveServiceConfig(workspaceId, block)
    // A Deployer on a `library` frame (not `deployable`) is a safe no-op regardless of any declared
    // provisioning — the runtime deploy loop records a library skip — so there is nothing to
    // validate. Checked BEFORE the provisioning branch, since a library may declare a compose path
    // as repo-local TEST infra (not a deployable env).
    if (service?.type && !frameProfile(service.type).deployable) return
    const provisioning = service?.provisioning
    // A Deployer on an `infraless`/undeclared service is a safe no-op (nothing to provision), so
    // there is nothing to validate — matching the deployer's own skip in advanceDeployerFrames.
    if (!provisioning || provisioning.type === 'infraless') return
    const type = provisioning.type

    const serviceIssues = deployerServiceConfigIssues(provisioning)
    // `canProvision` is a single batched handler read (no decrypt / no N+1); safe to run eagerly.
    // Pass the initiator so a local per-user handler override resolves exactly as provisioning does
    // (else a valid override-only local setup would be falsely reported as unhandled).
    const handlerResolution = await this.environmentProvisioning.canProvision(
      workspaceId,
      provisioning,
      initiatedBy,
    )
    // Only probe the LIVE connection when the structural config is sound — a network probe is
    // wasted (and its verdict misleading) while the service config is incomplete or no handler
    // resolves. A probe FAULT (transient network / provider-build hiccup) is not a definitive
    // "connection broken" verdict, so swallow it and let the async provision surface a real fault
    // rather than blocking the start on a flake.
    let connectionTest: ConnectionTestResult | undefined
    if (serviceIssues.length === 0 && handlerResolution.ok) {
      try {
        connectionTest =
          (await this.environmentProvisioning.testProvisioning(
            workspaceId,
            provisioning,
            initiatedBy,
          )) ?? undefined
      } catch {
        connectionTest = undefined
      }
    }

    const decision = decideDeployerConfig({
      provisionType: type,
      serviceIssues,
      handlerResolution,
      ...(connectionTest ? { connectionTest } : {}),
    })
    if (decision.ok) return

    if (decision.reason === 'service-config-incomplete') {
      // Deep-link target: the service FRAME's environment config (the inspector / compose wizard).
      const frameId =
        block.level === 'frame'
          ? block.id
          : ((await this.contextBuilder.resolveServiceFrameId(workspaceId, block.id)) ?? undefined)
      throw new ConflictError(
        `This service provisions a '${type}' environment via the Deployer, but its environment ` +
          `configuration is incomplete (missing: ${decision.missing.join(', ')}). Complete the ` +
          "service's environment configuration before starting.",
        'deployer_service_provisioning_incomplete',
        { provisionType: type, missing: [...decision.missing], ...(frameId ? { frameId } : {}) },
      )
    }
    if (decision.reason === 'workspace-unhandled') {
      throw new ConflictError(
        `This service provisions a '${type}' environment via the Deployer, but this workspace has ` +
          (decision.handlerReason === 'type-mismatch'
            ? `more than one handler matching it — pin a manifest id to disambiguate, `
            : `no infrastructure handler configured for that type — `) +
          'configure a handler (Infrastructure → Test environments), or set the service to ' +
          'infraless, before starting.',
        'provision_type_unhandled',
        { provisionType: type },
      )
    }
    // decision.reason === 'connection-failed'
    throw new ConflictError(
      `The '${type}' deployment integration for this service isn't working: ` +
        `${decision.message ?? 'the connection test failed'}. Check the handler's endpoint and ` +
        'credentials (Infrastructure → Test environments) and re-test the connection, then start ' +
        'again.',
      'deployer_connection_test_failed',
      { provisionType: type, ...(decision.message ? { detail: decision.message } : {}) },
    )
  }

  /**
   * Guard a pipeline's start when it carries an agent kind that RELIES on binary-artifact
   * storage (the {@link BINARY_STORAGE_TRAIT}, e.g. the UI Tester, which uploads its
   * screenshots there). Such a run would otherwise dispatch and then fail/degrade with no
   * place to store its artifacts, so refuse it up-front with a clear, actionable
   * `binary_storage_unconfigured` conflict the SPA turns into a "configure storage" prompt.
   * The check is trait-driven so it stays universal: a future artifact-producing kind just
   * carries the trait. Pass-through when no store resolver is wired (tests/conformance with
   * no storage) — matching the other optional start guards.
   */
  private async assertBinaryStorageConfigured(
    workspaceId: string,
    agentKinds: readonly string[],
  ): Promise<void> {
    if (!agentKinds.some((kind) => hasTrait(kind, BINARY_STORAGE_TRAIT, this.agentKindRegistry)))
      return
    const resolve = this.resolveBinaryArtifactStore
    if (!resolve) return
    const store = await resolve(workspaceId)
    if (store) return
    throw new ConflictError(
      'This pipeline includes an agent that needs binary storage (e.g. the UI Tester, which uploads its screenshots), but this account has no content storage configured. Configure content storage to run it.',
      'binary_storage_unconfigured',
    )
  }

  /**
   * Guard a pipeline's start when it carries a BINARY-GENERATING step (a kind with the
   * {@link BINARY_OUTPUT_TRAIT} — e.g. a deployment's image generator, whose deliverable is
   * binary artifacts pushed into a foundational storage service): the step's selection
   * (`stepOptions.binaryOutput`) must RESOLVE against the workspace's catalog — the storage id
   * must exist and carry the `asset-storage` capability tag, each context id must exist —
   * refused with `binary_output_service_invalid`. The catalog can change after the pipeline was
   * saved, which is why this re-validates at every start/retry/restart.
   *
   * The refusal names EVERY unresolved id, not the first: the message comes from
   * `describeBinaryOutputConfigIssues` and `details.issues` carries the machine-readable list,
   * so one edit clears a step that lost three services rather than three refuse-fix-restart
   * rounds. `details.serviceId` / `problem` / `role` stay on the envelope as the headline the
   * SPA's toast reads.
   *
   * The selection's PRESENCE is deliberately not checked here: that is a structural pipeline
   * fault `assertValidBinaryOutputSteps` (in `validatePipelineShape`, which every entry point
   * runs first) already refuses at save AND start — a second check here would be dead code.
   * Skipped when no catalog seam is wired (tests / unconfigured facades): the dispatch-time
   * brief then states whatever gap remains to the agent, which refuses loudly rather than
   * guessing at a storage endpoint. Evaluated over the ENABLED subset, like every other shape
   * check — a disabled generator never runs, so it imposes no requirement.
   */
  private async assertBinaryOutputSelected(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    stepOptions: readonly (StepOptions | null)[] | undefined,
    enabled: readonly boolean[] | undefined,
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    const steps = agentKinds.flatMap((kind, i) => {
      const config = stepOptions?.[i]?.binaryOutput
      if (!config || enabled?.[i] === false) return []
      if (!hasTrait(kind, BINARY_OUTPUT_TRAIT, this.agentKindRegistry)) return []
      return [{ kind, config }]
    })
    if (steps.length === 0) return
    // The GENERATIVE half first: it resolves against deployment code, so a step selecting an
    // integration nobody registered is refused even on a deployment with no catalog seam wired —
    // and refusing it BEFORE the catalog read means the operator hears about the fault they can
    // fix in their own build rather than about the workspace's catalog.
    await this.assertBinaryGeneratorsSelected(steps, () =>
      this.resolveStepHarnesses(
        workspaceId,
        block,
        steps.map((step) => step.kind),
        initiatedBy,
      ),
    )
    const resolver = this.foundationalServiceResolver
    if (!resolver) return
    const catalog = await resolver.catalogFor(workspaceId)
    for (const { kind, config } of steps) {
      const issues = binaryOutputConfigIssues(config, catalog)
      const first = issues[0]
      if (!first) continue
      throw new ConflictError(
        describeBinaryOutputConfigIssues(kind, issues),
        'binary_output_service_invalid',
        {
          agentKind: kind,
          serviceId: first.serviceId,
          problem: first.problem,
          role: first.role,
          issues: issues.map(({ role, serviceId, problem }) => ({ role, serviceId, problem })),
        },
      )
    }
  }

  /**
   * The GENERATIVE half of {@link assertBinaryOutputSelected}: every integration a binary-
   * generating step selects (`stepOptions.binaryOutput.generatorIds`) must be one this
   * deployment REGISTERS, and every content type the step declares it delivers
   * (`binaryOutput.modalities`) must be produced by at least one of them — refused with
   * `binary_output_generator_invalid`.
   *
   * A SEPARATE refusal from the storage-side one on purpose. The two resolve against different
   * registries and need different people: an unresolved storage id is workspace state somebody
   * can fix in the app, while an unknown integration id means nobody registered it in this
   * BUILD — the same reason kept apart in the message, the reason code and the SPA's remedy copy.
   *
   * An UNWIRED source is treated as an EMPTY one, which is the honest reading — a deployment
   * that registers no integrations cannot satisfy a step that selects one.
   *
   * An UNREACHABLE one is the opposite fact and must not collapse into it. The source is remote
   * on a mothership-mode node, where it throws rather than answering empty precisely so this
   * check cannot refuse a correctly configured step with `unknown_generator` for the duration of
   * an outage — a false configuration error, reported against the very step the product's own
   * picker just filled in, which is the misattribution the remote source exists to remove. The
   * throw is therefore RE-THROWN, not re-mapped: it is already an `UnavailableError` naming
   * `binary_generators_unreachable`, so the caller gets a 503-shaped, retryable refusal that
   * says the deployment could not read its integrations, and the operator is pointed at the
   * mothership rather than at a step with nothing wrong with it.
   */
  private async assertBinaryGeneratorsSelected(
    steps: readonly { kind: string; config: NonNullable<StepOptions['binaryOutput']> }[],
    resolveHarnesses: () => Promise<ReadonlyMap<string, string>>,
  ): Promise<void> {
    const generators = (await this.binaryGeneratorSource?.views()) ?? []
    // Resolved only when the deployment registers something the answer could refuse. It is a
    // THUNK rather than a resolved map because a resolution costs a provider-capability read plus
    // a workspace-default lookup per step, and every deployment registering only API-transport
    // integrations would otherwise pay for it on every start of every pipeline carrying a
    // binary-output step, to check a rule that cannot fire.
    const harnessByKind = generators.some(isHarnessTransport)
      ? await resolveHarnesses()
      : new Map<string, string>()
    for (const { kind, config } of steps) {
      const issues = binaryGeneratorSelectionIssues(config, generators, harnessByKind.get(kind))
      const first = issues[0]
      if (!first) continue
      throw new ConflictError(
        describeBinaryGeneratorSelectionIssues(kind, issues),
        'binary_output_generator_invalid',
        {
          agentKind: kind,
          problem: first.problem,
          ...namedSubject(first),
          issues,
        },
      )
    }
  }

  /**
   * Which agent CLI each named step will dispatch under.
   *
   * Derived rather than declared, and that is the whole design decision behind the harness pin: a
   * model's harness is already a fact of the catalog, so a `canGenerateImages`-style flag on the
   * model table would be a second copy of a truth nobody can verify — the tool is provisioned by
   * the vendor per session, not by anything this build can see. What the model legitimately
   * contributes is WHICH CLI runs, and that is exactly what this reads.
   *
   * It must therefore answer what `ModelRouter.resolveDispatchRef` will answer, and the two halves
   * of that are both easy to get wrong in the direction that REFUSES a run which would have worked:
   *
   *  - The precedence FALLS THROUGH an unresolvable block pin (`resolveStepModelRef`), it does not
   *    stop at one. Reading `block.modelId ?? default` skips the check on a stale pin — the block
   *    most likely to be misconfigured — while dispatch happily runs the workspace default.
   *  - "Subscriptions always win" then overrides the catalog's own flavour order, which places
   *    `subscription` LAST: a dual-mode model on a workspace holding a token for its vendor
   *    resolves `direct` here and dispatches on the subscription harness, so the guard would
   *    refuse a codex-served generator on a step that is about to run codex.
   *
   * Applied through `subscriptionOptionFor` + `caps.subscriptionVendors`, the same approximation
   * {@link modelIdIsMetered} uses for the same override, so admission has ONE reading of it.
   *
   * A kind whose model does not resolve is simply ABSENT from the map, never guessed at: the
   * caller reads a missing entry as "unverifiable" and refuses nothing, which is the same third
   * outcome the format, capability and value axes all take. That also covers dispatch's LAST tier,
   * the per-kind env routing, which carries no catalog id and is deliberately ungated here exactly
   * as it is in {@link assertProvidersConfiguredForPipeline}.
   */
  private async resolveStepHarnesses(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    initiatedBy: string | null | undefined,
  ): Promise<ReadonlyMap<string, string>> {
    const harnesses = new Map<string, string>()
    if (!this.resolveProviderCapabilities) return harnesses
    const caps = await this.resolveProviderCapabilities(
      workspaceId,
      initiatedBy,
      block.modelPresetId,
    )
    // Resolved per kind, because a block with no (usable) pin takes the workspace's per-kind
    // default and two binary-output steps in one chain can legitimately run different models.
    const refs = await Promise.all(
      agentKinds.map(async (kind) => {
        const pinned = this.effectiveModelRef(block.modelId, caps)
        if (pinned) return pinned
        const defaultId = await this.resolveWorkspaceModelDefault?.(
          workspaceId,
          kind,
          block.modelPresetId,
        )
        return this.effectiveModelRef(defaultId, caps)
      }),
    )
    agentKinds.forEach((kind, i) => {
      const ref = refs[i]
      // `harness` absent on a resolved ref means the default Pi harness, which is a RESOLVED
      // answer rather than a missing one — spelled out here so a Pi-served step is checked
      // rather than silently skipped.
      if (ref) harnesses.set(kind, ref.harness ?? 'pi')
    })
    return harnesses
  }

  /**
   * One model id resolved the way the DISPATCH will resolve it, subscription override included.
   *
   * The override applies only to a model that resolved WITHOUT a harness, which is exactly
   * `resolveEffectiveRef`'s own condition: a ref that already carries one came off the
   * subscription flavour, so there is nothing to swap it for.
   */
  private effectiveModelRef(
    id: string | undefined,
    caps: ProviderCapabilities,
  ): ModelRef | undefined {
    const ref = resolveModelRef(id, caps)
    if (!ref || ref.harness) return ref
    const sub = subscriptionOptionFor(id)
    return sub && caps.subscriptionVendors.has(sub.vendor) ? sub.ref : ref
  }

  /**
   * Guard a pipeline's start on having a usable provider for every step's canonical
   * model. The model a step runs is resolved by the same precedence the dispatch path
   * uses (block pin → workspace per-kind default); each canonical id must have a usable
   * provider given what's configured — a direct API key for its provider, a connected
   * subscription vendor, or the opt-in Cloudflare lib enabled. Env-routing defaults (the
   * last fallback, with no catalog id) are operator-level and not gated, matching the
   * personal-credential gate. A throw aborts the start cleanly before any side effects.
   * Skipped when no capability resolver is wired (tests / unconfigured facades).
   */
  private async assertProvidersConfiguredForPipeline(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    if (!this.resolveProviderCapabilities) return
    // Resolved under the block's own preset, so the guard walks each model's routes in the order
    // the dispatch will: a preset preferring Bedrock must be checked against the Bedrock route,
    // not the default order's first usable one.
    const caps = await this.resolveProviderCapabilities(
      workspaceId,
      initiatedBy,
      block.modelPresetId,
    )
    const runsInline = this.inlineHarnessRef
    // Two failure buckets, so the error can steer the fix precisely:
    //  - `unconfigured`: no usable provider AT ALL (container or inline) — add a key/sub/CF.
    //  - `inlineUnsatisfiable`: usable for a container step but NOT for an INLINE step — a
    //    subscription-only model an inline `generateText` call can't drive (and this
    //    deployment can't run the harness inline). The remedy is different (pin an
    //    inline-capable model, or a preset whose inline steps resolve to one), so a subscription
    //    model that satisfies the container steps but strands the reviewer/brainstorm/estimator
    //    is refused up front instead of failing mid-run against an ungated env default.
    //  - `policyBlocked`: the account-wide model-family policy blocks the model on its
    //    effective route — a distinct, more actionable reason than "unconfigured", so it is
    //    checked FIRST and short-circuits the other buckets for that id.
    const unconfigured = new Set<string>()
    const inlineUnsatisfiable = new Set<string>()
    const policyBlocked = new Set<string>()
    const check = (id: string | undefined, inline: boolean): void => {
      if (!id) return
      if (
        caps.modelPolicy &&
        !isAllowedByFamilyPolicy(id, resolveModelRef(id, caps)?.provider, caps.modelPolicy)
      ) {
        policyBlocked.add(id)
        return
      }
      if (!isModelUsable(id, caps)) unconfigured.add(id)
      else if (inline && !isModelUsableInline(id, caps, runsInline)) inlineUnsatisfiable.add(id)
    }
    if (block.modelId) {
      // A block-level pin applies to every step; it must satisfy an inline step too when the
      // pipeline has one.
      check(
        block.modelId,
        agentKinds.some((kind) => isInlineModelStep(kind, this.agentKindRegistry)),
      )
    } else if (this.resolveWorkspaceModelDefault) {
      // Independent per-kind resolutions on the start path — run them concurrently.
      const ids = await Promise.all(
        agentKinds.map((kind) =>
          this.resolveWorkspaceModelDefault!(workspaceId, kind, block.modelPresetId),
        ),
      )
      agentKinds.forEach((kind, i) =>
        check(ids[i], isInlineModelStep(kind, this.agentKindRegistry)),
      )
    }
    if (policyBlocked.size > 0) {
      throw new ConflictError(
        `This pipeline uses models blocked by the account's model-family policy: ` +
          `${[...policyBlocked].join(', ')}. Pick a model from an allowed family (or a ` +
          'residency-guaranteed route), or ask an account admin to adjust the policy.',
        'model_policy_blocked',
        { models: [...policyBlocked] },
      )
    }
    if (unconfigured.size > 0) {
      // Name the routes each model DECLARES rather than "add an API key for the provider": a
      // subscription-or-gateway-only model (`gpt-5.6-sol`, `claude-opus`) has a vendor that sells a
      // key no route accepts, so the generic remedy sends an operator to buy one and land back on
      // this same refusal. `details.models` stays the bare ids the SPA and the SDKs read.
      const named = [...unconfigured].map((id) => {
        const routes = declaredModelRouteLabels(id, caps)
        return routes.length > 0 ? `${id} (needs ${routes.join(' or ')})` : id
      })
      throw new ConflictError(
        `This pipeline uses models with no configured provider: ${named.join(', ')}. ` +
          'Configure one of the routes named above (an API key, a connected subscription, or ' +
          'Cloudflare AI) before starting.',
        'providers_unconfigured',
        { models: [...unconfigured] },
      )
    }
    if (inlineUnsatisfiable.size > 0) {
      throw new ConflictError(
        `This pipeline has inline steps (e.g. the requirements reviewer) whose model ` +
          `cannot run inline: ${[...inlineUnsatisfiable].join(', ')}. A subscription-only model ` +
          '(Claude / GPT / GLM) runs only in the container agents, not the inline reviewers — ' +
          'and this deployment has no inline harness. Pick a model preset whose inline steps ' +
          'resolve to a provider-backed model (a direct API key, OpenRouter, or Cloudflare AI), ' +
          'or run local mode with the ambient Claude Code / Codex CLI enabled.',
        'preset_unsatisfiable',
        { models: [...inlineUnsatisfiable] },
      )
    }
  }

  /**
   * Refuse to START / RETRY a run when the workspace has reached its spend budget AND the
   * pipeline has at least one budget-METERED step. A `0` (or exhausted) budget is a
   * deliberate "no paid spend" setting, but it must surface as a clear, up-front error here
   * rather than a silent mid-run pause. Steps that incur no metered cost — a connected
   * subscription model, or a keyless local-runner model — are exempt, so a workspace that
   * runs ONLY local/subscription models starts normally even at a `0` budget. Best-effort:
   * with no capability resolver wired (tests/unconfigured) it is skipped and the mid-run
   * gate still guards. Before any side effects, matching the other start guards.
   */
  private async assertBudgetAllowsPipeline(
    workspaceId: string,
    block: Block,
    agentKinds: readonly string[],
    initiatedBy: string | null | undefined,
  ): Promise<void> {
    const accountId = await this.workspaceRepository.accountOf(workspaceId)
    if (!(await this.spend.isOverBudget(workspaceId, { accountId, userId: initiatedBy }))) return
    if (!this.resolveProviderCapabilities) return
    const caps = await this.resolveProviderCapabilities(
      workspaceId,
      initiatedBy,
      block.modelPresetId,
    )
    const ids: (string | undefined)[] = []
    if (block.modelId) {
      ids.push(block.modelId)
    } else if (this.resolveWorkspaceModelDefault) {
      ids.push(
        ...(await Promise.all(
          agentKinds.map((kind) =>
            this.resolveWorkspaceModelDefault!(workspaceId, kind, block.modelPresetId),
          ),
        )),
      )
    } else {
      ids.push(undefined)
    }
    if (!ids.some((id) => this.modelIdIsMetered(id, caps))) return
    throw new ConflictError(
      'This run has reached a spend budget (workspace, account, or user). New runs on metered ' +
        'models are paused until the budget is raised or the billing period resets. A task pinned ' +
        'to a local model or a connected subscription still runs.',
    )
  }
}

/**
 * The one id a generative-selection refusal is ABOUT, keyed by problem — a generator id, a
 * content type, or a format.
 *
 * Exhaustive over the issue union rather than a two-branch ternary, so the next member fails the
 * typecheck here instead of landing in `details` under whichever field the `else` happened to
 * name. The whole list still rides `details.issues`; this names the first one for a reader (and
 * for a client keying off a single subject) without ever mis-labelling it.
 */
function namedSubject(issue: BinaryGeneratorSelectionIssue): Record<string, string> {
  switch (issue.problem) {
    case 'unknown_generator':
      return { generatorId: issue.generatorId }
    case 'modality_uncovered':
      return { modality: issue.modality }
    case 'media_type_uncovered':
      return { mediaType: issue.mediaType }
    case 'capability_unsupported':
      return { capability: issue.capability }
    case 'option_value_unaccepted':
      // TWO fields, because neither half is the subject on its own: the option says which control
      // is wrong and the value says what about it. A client keying on `option` alone would report
      // "the aspect ratio is unsupported" about an option every selected integration supports.
      return { option: issue.value.option, requestedValue: issue.value.requested }
    case 'generator_harness_unavailable':
      // THREE fields for the same reason: the generator alone reads as "this integration is
      // broken" when the integration is fine and the step's MODEL is what does not reach it, so
      // both harnesses ride along and the client can name the actual choice a human has to make.
      return {
        generatorId: issue.generatorId,
        requiredHarness: issue.requiredHarness,
        resolvedHarness: issue.resolvedHarness,
      }
  }
}
