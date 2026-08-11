import type {
  ClonePipelineInput,
  CreatePipelineInput,
  OrganizePipelineInput,
  UpdatePipelineInput,
} from '@cat-factory/contracts'
import type {
  ConsensusStepConfig,
  Pipeline,
  RunDefaultScope,
  StepGating,
  StepOptions,
  TesterQualityConfig,
} from '@cat-factory/kernel'
import type { GateRegistry, PipelineRegistry } from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  declaredDefaultPipelineId,
  noopOperationalMetrics,
  retiredPipelines,
  offeredPipelines,
  seedPipelines,
  ValidationError,
} from '@cat-factory/kernel'
import type {
  ObservabilityConnectionRepository,
  PipelineRepository,
  PipelineScheduleRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  adoptedCatalogRow,
  createPipelineAdoption,
  type PipelineAdoption,
} from './pipelineAdoption.js'
import {
  assertPipelineLaunchable,
  pipelineHasEnabledBugIntake,
  validatePipelineShape,
} from './pipelineShape.js'
import { validatePipelineAuthoring } from './pipelineAuthoring.js'

/**
 * The post-release-health gate watches a released PR's observability signals, so it is
 * meaningless (and rejected) on a workspace with no observability integration wired. It
 * is NOT part of any default pipeline — a user adds it deliberately, and only then.
 */
const OBSERVABILITY_GATED_KIND = 'post-release-health'

export interface PipelineServiceDependencies {
  workspaceRepository: WorkspaceRepository
  pipelineRepository: PipelineRepository
  idGenerator: IdGenerator
  /**
   * The app-owned pipeline registry (deployment-registered extra pipelines). When wired, a
   * reseed resolves a deployment-registered built-in pipeline too. Optional — absent (tests) ⇒
   * the built-in catalog only.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * The app-owned agent-kind registry, so a save honours a DEPLOYMENT-registered kind's own
   * `gatable` flag — the same answer the run-start guard reaches. Optional so the service stays
   * constructible standalone in unit tests; absent ⇒ built-in gatability only.
   *
   * `createCore` passes the instance `resolveCoreRuntime` RESOLVED (the facade's, else the default),
   * which is the same one `RunAdmission` gets. Passing `CoreDependencies.agentKindRegistry` straight
   * through instead would hand this `undefined` on every facade that doesn't inject one, and the two
   * boundaries would then be answering "may this step be gated?" from different registries.
   */
  agentKindRegistry?: AgentKindRegistry
  /**
   * The app-owned gate registry, so a save validates a step's gate PARAMETERS against the fields
   * the gate itself declared — the same registry, and so the same answer, the run-start guard
   * reaches. Optional for the same reason as {@link agentKindRegistry}; absent ⇒ gate parameters
   * are not checked here, and run admission still refuses them.
   */
  gateRegistry?: GateRegistry
  /**
   * Resolves whether the workspace has any observability integration enabled (today: a
   * Datadog connection). When absent (no observability persistence wired at all), the
   * observability-gated step can never be added.
   */
  observabilityConnectionRepository?: ObservabilityConnectionRepository
  /**
   * Recurring schedules, used to reject an edit that would make a pipeline un-schedulable
   * (`availability: 'one-off'`) while a schedule still points at it — the pipeline-edit dual of
   * the schedule-attach gate. Absent (no recurring persistence wired) ⇒ the cross-check is
   * skipped.
   */
  pipelineScheduleRepository?: PipelineScheduleRepository
}

/**
 * Resolve each updatable pipeline field to its new value: a supplied field wins, else the
 * existing one is preserved. `description` is explicit-undefined (not `??`) so a blank string
 * CLEARS it while omitting the field keeps the existing one. Split out of {@link
 * PipelineService.update} to keep it under the complexity ceiling.
 */
function resolveUpdatedPipelineFields(input: UpdatePipelineInput, existing: Pipeline) {
  return {
    agentKinds: input.agentKinds ?? existing.agentKinds,
    gates: input.gates ?? existing.gates,
    thresholds: input.thresholds ?? existing.thresholds,
    enabled: input.enabled ?? existing.enabled,
    consensus: input.consensus ?? existing.consensus,
    gating: input.gating ?? existing.gating,
    followUps: input.followUps ?? existing.followUps,
    testerQuality: input.testerQuality ?? existing.testerQuality,
    stepOptions: input.stepOptions ?? existing.stepOptions,
    labels: input.labels ?? existing.labels,
    availability: input.availability ?? existing.availability,
    purpose: input.purpose ?? existing.purpose,
    description: input.description !== undefined ? input.description : existing.description,
  }
}

/** Saved, reusable pipelines (the pipeline palette). */
export class PipelineService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly idGenerator: IdGenerator
  private readonly observabilityConnectionRepository?: ObservabilityConnectionRepository
  private readonly pipelineScheduleRepository?: PipelineScheduleRepository
  private readonly pipelineRegistry?: PipelineRegistry
  private readonly agentKindRegistry?: AgentKindRegistry
  private readonly gateRegistry?: GateRegistry
  private readonly adoption: PipelineAdoption

  constructor({
    workspaceRepository,
    pipelineRepository,
    idGenerator,
    observabilityConnectionRepository,
    pipelineScheduleRepository,
    pipelineRegistry,
    agentKindRegistry,
    gateRegistry,
  }: PipelineServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.pipelineRepository = pipelineRepository
    this.idGenerator = idGenerator
    this.observabilityConnectionRepository = observabilityConnectionRepository
    this.pipelineScheduleRepository = pipelineScheduleRepository
    this.pipelineRegistry = pipelineRegistry
    this.agentKindRegistry = agentKindRegistry
    this.gateRegistry = gateRegistry
    // The same collaborator the engine resolves runs through, so an admission read and the run it
    // admits can never disagree about what a pipeline id means. `noopOperationalMetrics` rather
    // than a threaded sink because this instance only ever answers the READ half: adoption's
    // counter belongs to the write, which happens on the engine's own instance.
    this.adoption = createPipelineAdoption({
      pipelineRepository,
      pipelineRegistry,
      operationalMetrics: noopOperationalMetrics,
    })
  }

  /**
   * The post-release-health gate is only meaningful with an observability integration, so
   * reject a chain that includes an ENABLED post-release-health step unless the workspace
   * has one wired. Validated only when the chain/enable mask is being authored (create, or
   * an update that changes them) so an unrelated edit to an existing pipeline never trips.
   */
  private async assertObservabilityGatedStepAllowed(
    workspaceId: string,
    agentKinds: string[],
    enabled: boolean[] | undefined,
  ): Promise<void> {
    const present = agentKinds.some(
      (kind, i) => kind === OBSERVABILITY_GATED_KIND && enabled?.[i] !== false,
    )
    if (!present) return
    const connection = await this.observabilityConnectionRepository?.get(workspaceId)
    if (!connection) {
      throw new ValidationError(
        `The '${OBSERVABILITY_GATED_KIND}' step needs an observability integration. Connect an observability provider for this workspace first.`,
      )
    }
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  /**
   * The workspace's pipeline LIBRARY — what the builder, the pickers and the health advisory work
   * against. INTERNAL pipelines are withheld ({@link offeredPipelines}): the platform starts them
   * by id for a flow of its own, and a row nobody may pick, clone or edit has no business in a
   * library. They still resolve for a run through {@link resolveForRun}, which is the whole point.
   */
  async list(workspaceId: string): Promise<Pipeline[]> {
    await this.requireWorkspace(workspaceId)
    return offeredPipelines(
      await this.pipelineRepository.listByWorkspace(workspaceId),
      seedPipelines(this.pipelineRegistry),
    )
  }

  /**
   * The definition a run under this id WOULD use, or null when nothing defines it: the stored row,
   * else the catalog built-in the workspace has not adopted yet (`pipelineAdoption`). Reads only.
   *
   * This is what an ADMISSION check must ask, and asking the bare row instead is a real hole rather
   * than a nicety. The public API's start paths resolve a caller-supplied `pipelineId` to decide
   * whether to admit it, and a row-only read answers `null` for a pipeline `ExecutionService.start`
   * then ADOPTS and runs: the decide-scope refusal was skipped for want of a pipeline to inspect,
   * and a `write`-only key could set in motion exactly the parked run that scope exists to withhold.
   * So admission and the run resolve through one answer, differing only in that this one never
   * writes. (It replaced a `get` that returned the stored row; nothing wants that read any more.)
   *
   * Deliberately returns null rather than throwing, unlike the mutating paths that go through
   * `assertFound`: an unknown id is not this method's error to raise. Both callers hand the id on to
   * `ExecutionService.start`, which owns the "no such pipeline" refusal and its message.
   */
  async resolveForRun(workspaceId: string, id: string): Promise<Pipeline | null> {
    await this.requireWorkspace(workspaceId)
    return this.adoption.resolveDefinition(workspaceId, id)
  }

  /**
   * The pipeline id a run of this RESOLUTION SCOPE falls back to when neither the caller nor the
   * task named one, or `null` when the workspace has no answer for that scope.
   *
   * `null` is a real answer and the caller states it as one: the public start path keeps its
   * `pipeline_required` refusal, because a headless caller has no run-time picker and inventing a
   * rung for it would run work nobody chose.
   *
   * The ladder is stored-then-catalog, and the second rung is bounded on purpose. A workspace
   * seeded before a rung existed holds no row for it, so reading only the library would leave every
   * existing deployment on the old refusal until somebody opened the board and accepted a reseed
   * advisory — the same trap `pipelineAdoption` exists to close for a PINNED pipeline. But once the
   * row IS in the library, its flags are the operator's own answer, INCLUDING the absence of one:
   * releasing a default has to mean something, so the catalog is consulted only while the workspace
   * has never adopted the rung the catalog declares.
   */
  async defaultPipelineIdForScope(
    workspaceId: string,
    scope: RunDefaultScope,
  ): Promise<string | null> {
    await this.requireWorkspace(workspaceId)
    const stored = await this.pipelineRepository.listByWorkspace(workspaceId)
    const declared = declaredDefaultPipelineId(stored, scope)
    if (declared) return declared
    const fromCatalog = declaredDefaultPipelineId(seedPipelines(this.pipelineRegistry), scope)
    if (!fromCatalog) return null
    return stored.some((pipeline) => pipeline.id === fromCatalog) ? null : fromCatalog
  }

  async create(workspaceId: string, input: CreatePipelineInput): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    assertSomeEnabled(input.agentKinds, input.enabled)
    validatePipelineShape({
      agentKinds: input.agentKinds,
      enabled: input.enabled,
      gates: input.gates,
      gating: input.gating,
      testerQuality: input.testerQuality,
      stepOptions: input.stepOptions,
      agentKindRegistry: this.agentKindRegistry,
      gateRegistry: this.gateRegistry,
    })
    // Authoring-only correctness (see `validatePipelineAuthoring`): the environment lifecycle a
    // composed chain has to spell out: provision, consume, reclaim. Not part of the shared shape
    // validation, because a pipeline authored before this rule still RUNS.
    validatePipelineAuthoring({
      agentKinds: input.agentKinds,
      enabled: input.enabled,
      stepOptions: input.stepOptions,
    })
    // Launch-constraint validation (no origin — a save, not a launch): a `bug-intake` step
    // requires a recurring pipeline. `availability` absent ⇒ `'both'` (unrestricted). Evaluated
    // over the enabled subset — a disabled bug-intake step imposes no requirement.
    assertPipelineLaunchable(input.agentKinds, input.availability, undefined, input.enabled)
    await this.assertObservabilityGatedStepAllowed(workspaceId, input.agentKinds, input.enabled)
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name.trim() || 'Untitled pipeline',
      ...normalizedDescription(input.description),
      agentKinds: [...input.agentKinds],
      ...alignedGates(input.agentKinds, input.gates),
      ...alignedThresholds(input.agentKinds, input.thresholds),
      ...alignedEnabled(input.agentKinds, input.enabled),
      ...alignedConsensus(input.agentKinds, input.consensus),
      ...alignedGating(input.agentKinds, input.gating),
      ...alignedFollowUps(input.agentKinds, input.followUps),
      ...alignedTesterQuality(input.agentKinds, input.testerQuality),
      ...alignedStepOptions(input.agentKinds, input.stepOptions),
      ...normalizedLabels(input.labels),
      ...(input.availability ? { availability: input.availability } : {}),
      purpose: input.purpose,
    }
    await this.pipelineRepository.insert(workspaceId, pipeline)
    return pipeline
  }

  /**
   * Clone any pipeline (built-in or custom) into a new, editable copy. The copy keeps
   * the source's steps / gates / thresholds / enable flags but is never `builtin`, so
   * it can be edited — this is how a built-in template is "made editable".
   */
  async clone(workspaceId: string, sourceId: string, input: ClonePipelineInput): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    const source = assertFound(
      await this.pipelineRepository.get(workspaceId, sourceId),
      'Pipeline',
      sourceId,
    )
    // Validate the source's shape so a clone is rejected at clone time, not deferred to run
    // start — the same guarantee `create`/`update` give (a built-in can't ship invalid, but
    // a custom source mutated out of band could).
    validatePipelineShape({
      agentKinds: source.agentKinds,
      enabled: source.enabled,
      gates: source.gates,
      gating: source.gating,
      testerQuality: source.testerQuality,
      stepOptions: source.stepOptions,
      agentKindRegistry: this.agentKindRegistry,
      gateRegistry: this.gateRegistry,
    })
    // Same launch-constraint guarantee create/update give: a clone preserves the source's
    // agentKinds + availability, so re-check that the pair is launchable (e.g. a bug-intake step
    // without `availability: 'recurring'` must not be propagated into an un-runnable copy).
    assertPipelineLaunchable(source.agentKinds, source.availability, undefined, source.enabled)
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name?.trim() || `${source.name} (copy)`,
      // Carry the source's description onto the copy (the built-in's summary is a useful start).
      ...normalizedDescription(source.description),
      agentKinds: [...source.agentKinds],
      ...(source.gates ? { gates: [...source.gates] } : {}),
      ...(source.thresholds ? { thresholds: [...source.thresholds] } : {}),
      ...(source.enabled ? { enabled: [...source.enabled] } : {}),
      ...(source.consensus ? { consensus: [...source.consensus] } : {}),
      ...(source.gating ? { gating: [...source.gating] } : {}),
      ...(source.followUps ? { followUps: [...source.followUps] } : {}),
      ...(source.testerQuality ? { testerQuality: [...source.testerQuality] } : {}),
      ...(source.stepOptions ? { stepOptions: [...source.stepOptions] } : {}),
      ...(source.labels ? { labels: [...source.labels] } : {}),
      // Preserve the launch constraint: cloning the recurring-only bug-triage built-in keeps the
      // copy recurring-only (else a manual start of the copy — bug-intake step and all — would slip
      // the gate). A `'both'`/unset source clones to unrestricted.
      ...(source.availability ? { availability: source.availability } : {}),
      // The use-case classifier is a property of the pipeline's shape, so a clone inherits it
      // (a cloned document pipeline stays a document pipeline).
      purpose: source.purpose,
      // A clone is a fresh, active, editable copy — never `builtin`, never `archived`.
    }
    await this.pipelineRepository.insert(workspaceId, pipeline)
    return pipeline
  }

  /**
   * Edit a custom pipeline in place. Only the supplied fields change; passing
   * `agentKinds` replaces the whole chain and re-aligns the parallel arrays. Built-in
   * catalog templates are read-only and reject this — clone them first.
   */
  async update(workspaceId: string, id: string, input: UpdatePipelineInput): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    if (existing.builtin) {
      throw new ValidationError(
        'Built-in pipelines are read-only. Clone it to make an editable copy.',
      )
    }
    const {
      agentKinds,
      gates,
      thresholds,
      enabled,
      consensus,
      gating,
      followUps,
      testerQuality,
      stepOptions,
      labels,
      availability,
      purpose,
      description,
    } = resolveUpdatedPipelineFields(input, existing)
    assertSomeEnabled(agentKinds, enabled)
    // Re-validate the shape against the EFFECTIVE (enabled) chain — disabling a producer
    // while leaving its companion on would orphan the companion, and adding gating (step or
    // tester-QC) without an estimator is illegal — so validate whenever the chain, enable
    // flags, gating, OR tester-QC change, not just on a chain replacement.
    //
    // `input.gates` is a trigger too: a human approval gate and an estimate gate on the SAME step
    // is illegal, so adding the approval gate to an already-estimate-gated step invalidates the
    // shape while touching neither the chain nor `gating`.
    if (
      input.agentKinds ||
      input.enabled ||
      input.gates ||
      input.gating ||
      input.testerQuality ||
      input.stepOptions
    ) {
      validatePipelineShape({
        agentKinds,
        enabled,
        gates,
        gating,
        testerQuality,
        stepOptions,
        agentKindRegistry: this.agentKindRegistry,
        gateRegistry: this.gateRegistry,
      })
      // The authoring rules bind an edit exactly as they bind a create: removing the Deployer from
      // a chain that still tests, or the Disposer from one that still deploys, is composing the
      // dead end rather than inheriting it.
      validatePipelineAuthoring({ agentKinds, enabled, stepOptions })
      await this.assertObservabilityGatedStepAllowed(workspaceId, agentKinds, enabled)
    }
    // Re-check the launch constraint when the chain, the enable mask, or the availability
    // changes — e.g. adding (or enabling) a `bug-intake` step, or relaxing a recurring pipeline
    // that carries one to `'both'`. Evaluated over the enabled subset.
    if (input.agentKinds || input.enabled || input.availability !== undefined) {
      assertPipelineLaunchable(agentKinds, availability, undefined, enabled)
    }
    // Pipeline-edit dual of the schedule-attach gate (see RecurringPipelineService): making a
    // pipeline one-off-only while a recurring schedule still points at it would silently fail
    // every future fire (each throws at origin='recurring'). Reject the edit — the user detaches
    // the schedule first. Only reachable when availability is actively changed to 'one-off'
    // (a schedule can't have been attached to an already-one-off pipeline).
    if (input.availability === 'one-off' && this.pipelineScheduleRepository) {
      const schedules = await this.pipelineScheduleRepository.list(workspaceId)
      if (schedules.some((s) => s.pipelineId === id)) {
        throw new ConflictError(
          'This pipeline is attached to a recurring schedule, so it cannot be made one-off. Detach the schedule first.',
          'pipeline_schedule_requires_recurring',
        )
      }
    }
    // The other pipeline-edit dual of the schedule-attach gate: adding (or enabling) a `bug-intake`
    // step pulls each attached schedule's work from its `issueIntake` config, so a schedule with no
    // config would then silently no-op every fire. `RecurringPipelineService` guards this at the
    // schedule boundary, but a pipeline edit never re-runs that validation — reject here instead,
    // pointing the user at the schedule. Only relevant once the edit yields an enabled bug-intake
    // step; a schedule with a config is untouched.
    if (
      pipelineHasEnabledBugIntake(agentKinds, enabled) &&
      (input.agentKinds || input.enabled) &&
      this.pipelineScheduleRepository
    ) {
      const schedules = await this.pipelineScheduleRepository.list(workspaceId)
      if (schedules.some((s) => s.pipelineId === id && !s.issueIntake)) {
        throw new ConflictError(
          'This pipeline is attached to a recurring schedule with no issue-intake configuration, so a bug-intake step cannot be enabled. Configure issue intake on the schedule first.',
          'pipeline_schedule_intake_unconfigured',
        )
      }
    }
    const pipeline: Pipeline = {
      id: existing.id,
      name: input.name?.trim() || existing.name,
      ...normalizedDescription(description),
      agentKinds: [...agentKinds],
      ...alignedGates(agentKinds, gates),
      ...alignedThresholds(agentKinds, thresholds),
      ...alignedEnabled(agentKinds, enabled),
      ...alignedConsensus(agentKinds, consensus),
      ...alignedGating(agentKinds, gating),
      ...alignedFollowUps(agentKinds, followUps),
      ...alignedTesterQuality(agentKinds, testerQuality),
      ...alignedStepOptions(agentKinds, stepOptions),
      ...normalizedLabels(labels),
      ...(availability ? { availability } : {}),
      purpose,
      // `archived` is organization-only state, mutated via `organize` — preserved here.
      ...(existing.archived ? { archived: true } : {}),
    }
    await this.pipelineRepository.update(workspaceId, pipeline)
    return pipeline
  }

  /**
   * Restore a built-in pipeline to its current catalog definition (`seedPipelines()`). Used to
   * adopt an improved built-in, repair a built-in whose persisted copy drifted invalid, or
   * materialise a NEW built-in that appeared in the catalog after this workspace was seeded (so it
   * has the old pipelines but not the new one — e.g. `pl_review` on a board created before it
   * shipped). The canonical steps / gates / `version` overwrite (or create) the stored row; an
   * existing copy's organizational metadata (labels / archive state, owned by `organize`) is
   * preserved. Keyed off the CATALOG (not the stored row) so a missing built-in can be added:
   * resolve the seed first, and reject only a custom id (a stored non-builtin — delete it instead)
   * or an id absent from the catalog (nothing to reseed from). Mirrors `RiskPolicyService.reseed` /
   * `ModelPresetService.reseed`, which surface + add brand-new built-in presets the same way.
   */
  async reseed(workspaceId: string, id: string): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    const seed = seedPipelines(this.pipelineRegistry).find((p) => p.id === id)
    if (!seed) {
      // A RETIRED built-in resolves nothing here (the two sets are disjoint), and its fix is the
      // opposite one — so name it rather than sending the user to a `remove` they'd have to
      // discover works. Every other unresolvable id is a custom pipeline (or a deployment
      // pipeline whose registry isn't wired), which stays a plain delete.
      const retired = retiredPipelines(this.pipelineRegistry).some((p) => p.id === id)
      throw new ValidationError(
        retired
          ? `Pipeline '${id}' has been retired from the catalog, so there is nothing to reseed it from. Remove it instead.`
          : `Pipeline '${id}' is not a built-in (or is no longer in the catalog), so it cannot be reseeded. Delete it instead.`,
      )
    }
    // A stored copy exists ⇒ it must be the built-in (a custom pipeline sharing a catalog id is
    // impossible — ids are minted `pl_<n>`), and its labels/archive state carry across. Absent ⇒
    // we're materialising the new built-in, so it starts with the seed's own metadata.
    const existing = await this.pipelineRepository.get(workspaceId, id)
    if (existing && !existing.builtin) {
      throw new ValidationError(
        'Only built-in pipelines can be reseeded. Delete a custom pipeline instead.',
      )
    }
    const pipeline = adoptedCatalogRow(seed, existing)
    // The absent branch goes through `insertIfAbsent` because it races the run path's adopt-on-
    // start (and a second reseed): both write this same catalog row, so losing is a no-op rather
    // than a duplicate-key 500 on whichever caller arrives second.
    if (existing) await this.pipelineRepository.update(workspaceId, pipeline)
    else await this.pipelineRepository.insertIfAbsent(workspaceId, pipeline)
    return pipeline
  }

  /**
   * Delete a pipeline. A custom one is always deletable; a BUILT-IN is deletable only once it has
   * been RETIRED from the catalog — which is how a withdrawn built-in is removed from a workspace
   * that was seeded with it before the withdrawal.
   *
   * Retirement is the deletion's authorization, and it has to be, because the reseed lifecycle
   * otherwise has no exit: a live built-in is read-only so its palette entry is always present
   * (clone it to customise), while a stale one used to be unreachable in BOTH directions — reseed
   * had nothing to resolve and delete refused it as a built-in, so it sat in every board's library
   * forever. Naming it in kernel's `buildRetiredPipelines` (or a deployment's
   * `PipelineRegistry.retire`) is what flips the same row from read-only to removable.
   */
  async remove(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    // Built-in catalog templates are read-only — they can be cloned but never deleted
    // (matching `update`), so the curated palette is always present. Clone to customise. The one
    // exception is a retirement: the catalog no longer offers it, so keeping the stored row
    // read-only would preserve a pipeline nothing can restore, repair, or replace.
    if (existing.builtin && !retiredPipelines(this.pipelineRegistry).some((p) => p.id === id)) {
      throw new ValidationError('Built-in pipelines are read-only and cannot be deleted.')
    }
    // Deleting a pipeline a recurring schedule still points at would break every future fire (each
    // one resolves the pipeline by id and throws), and a recurring failure is invisible until
    // someone notices the work stopped. Refuse and point at the schedule — the same disposition
    // `update` takes for the availability/bug-intake edits that would strand a schedule. Applies to
    // a custom pipeline as much as a retired built-in: the fire path cannot tell them apart.
    //
    // A DISABLED schedule blocks the delete too, deliberately: `enabled` is a pause button, so
    // filtering on it would let a delete strand a schedule whose owner re-enables it next week —
    // and the breakage would then be attributed to the re-enable, not to this. The cost is that
    // finishing a retirement cleanup means deleting a paused schedule, which the message names.
    if (this.pipelineScheduleRepository) {
      const schedules = await this.pipelineScheduleRepository.list(workspaceId)
      if (schedules.some((s) => s.pipelineId === id)) {
        throw new ConflictError(
          'This pipeline is attached to a recurring schedule, so it cannot be deleted. Detach the schedule first.',
          'pipeline_schedule_attached',
        )
      }
    }
    await this.pipelineRepository.delete(workspaceId, id)
  }

  /**
   * Set a pipeline's organizational metadata (labels and/or archive state). This is the
   * ONLY mutation allowed on a BUILT-IN pipeline — it touches the library view, not the
   * pipeline's structure, so a built-in can be tagged or archived while staying read-only
   * for its steps. Only the supplied fields change.
   */
  async organize(workspaceId: string, id: string, input: OrganizePipelineInput): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    // Explicit-undefined check (not `??`): passing `labels: []` clears the labels, while
    // omitting the field preserves the existing ones.
    const labels = input.labels !== undefined ? cleanLabels(input.labels) : existing.labels
    const archived = input.archived !== undefined ? input.archived : existing.archived
    const pipeline: Pipeline = {
      ...existing,
      ...(labels && labels.length ? { labels } : { labels: undefined }),
      ...(archived ? { archived: true } : { archived: undefined }),
    }
    await this.pipelineRepository.update(workspaceId, pipeline)
    // The default claims go through their OWN store call, because promoting touches a SECOND row
    // (the incumbent) and `update` deliberately does not carry the flags. Applied after the row
    // write so a rejected edit never leaves a moved default behind, and re-read so the returned
    // pipeline states what the store settled rather than what this request asked for.
    const claims = await this.applyDefaultClaims(workspaceId, pipeline, input)
    return claims ?? pipeline
  }

  /**
   * Apply the two default claims an organize request carried, returning the re-read pipeline when
   * either fired and `null` when the request named neither.
   *
   * An ARCHIVED or INTERNAL pipeline may not hold a default. Archiving is how a library hides a
   * rung and `internal` is how the platform withholds one, so either row answering every headless
   * start is the concealed-setting failure: a default nobody can see in the library they would go
   * to change it in. Refused rather than accepted-and-hidden, and judged against the row this
   * request just WROTE, so archiving and promoting in one call is refused whichever order the two
   * fields appear in.
   */
  private async applyDefaultClaims(
    workspaceId: string,
    pipeline: Pipeline,
    input: OrganizePipelineInput,
  ): Promise<Pipeline | null> {
    const requested = (
      [
        ['interactive', input.isDefault],
        ['unattended', input.isUnattendedDefault],
      ] as const satisfies readonly (readonly [RunDefaultScope, boolean | undefined])[]
    ).filter(([, claimed]) => claimed !== undefined)
    if (!requested.length) return null
    for (const [scope, claimed] of requested) {
      if (claimed === true && (pipeline.archived || pipeline.internal)) {
        throw new ValidationError('An archived or internal pipeline cannot be a default', {
          reason: 'pipeline_not_defaultable',
        })
      }
      await this.pipelineRepository.setDefault(workspaceId, pipeline.id, scope, claimed === true)
    }
    return assertFound(
      await this.pipelineRepository.get(workspaceId, pipeline.id),
      'Pipeline',
      pipeline.id,
    )
  }
}

// Keep gates aligned to agentKinds; only persist when at least one step is gated so an
// all-false / absent array stays absent (a straight-through run).
function alignedGates(agentKinds: string[], gates: boolean[] | undefined): Pick<Pipeline, 'gates'> {
  return gates?.some(Boolean) ? { gates: agentKinds.map((_, i) => gates[i] ?? false) } : {}
}

// Keep thresholds aligned to agentKinds; only persist when at least one step sets an
// explicit value (else companions fall back to their default bar).
function alignedThresholds(
  agentKinds: string[],
  thresholds: (number | null)[] | undefined,
): Pick<Pipeline, 'thresholds'> {
  return thresholds?.some((t) => t != null)
    ? { thresholds: agentKinds.map((_, i) => thresholds[i] ?? null) }
    : {}
}

// Keep enable flags aligned to agentKinds; only persist when at least one step is
// explicitly disabled (the default is "every step runs", i.e. no array at all).
function alignedEnabled(
  agentKinds: string[],
  enabled: boolean[] | undefined,
): Pick<Pipeline, 'enabled'> {
  return enabled?.some((e) => e === false)
    ? { enabled: agentKinds.map((_, i) => enabled[i] ?? true) }
    : {}
}

// Keep consensus configs aligned to agentKinds; only persist when at least one step is
// consensus-enabled (the default is no array at all → every step is a standard agent).
function alignedConsensus(
  agentKinds: string[],
  consensus: (ConsensusStepConfig | null)[] | undefined,
): Pick<Pipeline, 'consensus'> {
  return consensus?.some((c) => c?.enabled)
    ? { consensus: agentKinds.map((_, i) => consensus[i] ?? null) }
    : {}
}

// Keep gating aligned to agentKinds; only persist when at least one step has gating enabled
// (the default is no array at all → every step always runs).
function alignedGating(
  agentKinds: string[],
  gating: (StepGating | null)[] | undefined,
): Pick<Pipeline, 'gating'> {
  return gating?.some((g) => g?.enabled)
    ? { gating: agentKinds.map((_, i) => gating[i] ?? null) }
    : {}
}

// Keep the Follow-up companion toggles aligned to agentKinds; only persist when at least one
// step explicitly opts OUT (the default is on, so a `false` is the only value worth storing).
function alignedFollowUps(
  agentKinds: string[],
  followUps: (boolean | null)[] | undefined,
): Pick<Pipeline, 'followUps'> {
  return followUps?.some((f) => f === false)
    ? { followUps: agentKinds.map((_, i) => followUps[i] ?? null) }
    : {}
}

// Keep the test quality-control companion configs aligned to agentKinds; only persist when at
// least one Tester step deviates from the default (companion disabled, or an estimate gate
// configured) — the default (null/enabled, ungated) needs no array at all.
function alignedTesterQuality(
  agentKinds: string[],
  testerQuality: (TesterQualityConfig | null)[] | undefined,
): Pick<Pipeline, 'testerQuality'> {
  return testerQuality?.some((q) => q?.enabled === false || q?.gating?.enabled)
    ? { testerQuality: agentKinds.map((_, i) => testerQuality[i] ?? null) }
    : {}
}

// Keep the per-step options bag aligned to agentKinds; only persist when at least one step
// deviates from its defaults, i.e. carries a non-empty options object. Kept option-agnostic
// (any own key ⇒ store it) so a new StepOptions field needs no change here — the client is
// responsible for only setting non-default values (e.g. `autoRecommend: false`, never `true`).
function alignedStepOptions(
  agentKinds: string[],
  stepOptions: (StepOptions | null)[] | undefined,
): Pick<Pipeline, 'stepOptions'> {
  return stepOptions?.some((o) => o && Object.keys(o).length > 0)
    ? { stepOptions: agentKinds.map((_, i) => stepOptions[i] ?? null) }
    : {}
}

// Trim, drop blanks, and dedupe labels; undefined when none remain.
function cleanLabels(labels: string[] | undefined): string[] | undefined {
  if (!labels) return undefined
  const cleaned = [...new Set(labels.map((l) => l.trim()).filter(Boolean))]
  return cleaned.length ? cleaned : undefined
}

// Only persist labels when at least one survives cleaning.
function normalizedLabels(labels: string[] | undefined): Pick<Pipeline, 'labels'> {
  const cleaned = cleanLabels(labels)
  return cleaned ? { labels: cleaned } : {}
}

// Trim the description; a blank/absent one stays absent (so an empty string clears it on update).
function normalizedDescription(description: string | undefined): Pick<Pipeline, 'description'> {
  const trimmed = description?.trim()
  return trimmed ? { description: trimmed } : {}
}

/** A pipeline with every step disabled would have nothing to run. */
function assertSomeEnabled(agentKinds: string[], enabled: boolean[] | undefined): void {
  if (!enabled) return
  if (!agentKinds.some((_, i) => enabled[i] ?? true)) {
    throw new ValidationError('A pipeline must keep at least one step enabled.')
  }
}
