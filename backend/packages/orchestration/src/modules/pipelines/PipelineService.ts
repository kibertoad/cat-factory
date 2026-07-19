import type {
  ClonePipelineInput,
  CreatePipelineInput,
  OrganizePipelineInput,
  UpdatePipelineInput,
} from '@cat-factory/contracts'
import type {
  ConsensusStepConfig,
  Pipeline,
  StepGating,
  StepOptions,
  TesterQualityConfig,
} from '@cat-factory/kernel'
import type { PipelineRegistry } from '@cat-factory/kernel'
import { assertFound, ConflictError, seedPipelines, ValidationError } from '@cat-factory/kernel'
import type {
  ObservabilityConnectionRepository,
  PipelineRepository,
  PipelineScheduleRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import {
  assertPipelineLaunchable,
  pipelineHasEnabledBugIntake,
  validatePipelineShape,
} from './pipelineShape.js'

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

/** Saved, reusable pipelines (the pipeline palette). */
export class PipelineService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly idGenerator: IdGenerator
  private readonly observabilityConnectionRepository?: ObservabilityConnectionRepository
  private readonly pipelineScheduleRepository?: PipelineScheduleRepository
  private readonly pipelineRegistry?: PipelineRegistry

  constructor({
    workspaceRepository,
    pipelineRepository,
    idGenerator,
    observabilityConnectionRepository,
    pipelineScheduleRepository,
    pipelineRegistry,
  }: PipelineServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.pipelineRepository = pipelineRepository
    this.idGenerator = idGenerator
    this.observabilityConnectionRepository = observabilityConnectionRepository
    this.pipelineScheduleRepository = pipelineScheduleRepository
    this.pipelineRegistry = pipelineRegistry
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

  async list(workspaceId: string): Promise<Pipeline[]> {
    await this.requireWorkspace(workspaceId)
    return this.pipelineRepository.listByWorkspace(workspaceId)
  }

  async create(workspaceId: string, input: CreatePipelineInput): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    assertSomeEnabled(input.agentKinds, input.enabled)
    validatePipelineShape({
      agentKinds: input.agentKinds,
      enabled: input.enabled,
      gating: input.gating,
      testerQuality: input.testerQuality,
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
      ...(input.purpose ? { purpose: input.purpose } : {}),
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
      gating: source.gating,
      testerQuality: source.testerQuality,
      stepOptions: source.stepOptions,
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
      ...(source.purpose ? { purpose: source.purpose } : {}),
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
    const agentKinds = input.agentKinds ?? existing.agentKinds
    const gates = input.gates ?? existing.gates
    const thresholds = input.thresholds ?? existing.thresholds
    const enabled = input.enabled ?? existing.enabled
    const consensus = input.consensus ?? existing.consensus
    const gating = input.gating ?? existing.gating
    const followUps = input.followUps ?? existing.followUps
    const testerQuality = input.testerQuality ?? existing.testerQuality
    const stepOptions = input.stepOptions ?? existing.stepOptions
    const labels = input.labels ?? existing.labels
    const availability = input.availability ?? existing.availability
    const purpose = input.purpose ?? existing.purpose
    // Explicit-undefined (not `??`): the builder sends the full description (possibly blank) so a
    // blank string CLEARS it, while omitting the field preserves the existing one.
    const description = input.description !== undefined ? input.description : existing.description
    assertSomeEnabled(agentKinds, enabled)
    // Re-validate the shape against the EFFECTIVE (enabled) chain — disabling a producer
    // while leaving its companion on would orphan the companion, and adding gating (step or
    // tester-QC) without an estimator is illegal — so validate whenever the chain, enable
    // flags, gating, OR tester-QC change, not just on a chain replacement.
    if (
      input.agentKinds ||
      input.enabled ||
      input.gating ||
      input.testerQuality ||
      input.stepOptions
    ) {
      validatePipelineShape({ agentKinds, enabled, gating, testerQuality, stepOptions })
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
      ...(purpose ? { purpose } : {}),
      // `archived` is organization-only state, mutated via `organize` — preserved here.
      ...(existing.archived ? { archived: true } : {}),
    }
    await this.pipelineRepository.update(workspaceId, pipeline)
    return pipeline
  }

  /**
   * Restore a built-in pipeline to its current catalog definition (`seedPipelines()`).
   * Used to adopt an improved built-in or to repair a built-in whose persisted copy has
   * drifted invalid. The canonical steps / gates / `version` overwrite the stored row, but
   * the user's organizational metadata (labels / archive state, owned by `organize`) is
   * preserved. Rejects a custom pipeline (delete it instead) and a built-in id no longer in
   * the catalog (nothing to reseed from — also delete it instead).
   */
  async reseed(workspaceId: string, id: string): Promise<Pipeline> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    if (!existing.builtin) {
      throw new ValidationError(
        'Only built-in pipelines can be reseeded. Delete a custom pipeline instead.',
      )
    }
    const seed = seedPipelines(this.pipelineRegistry).find((p) => p.id === id)
    if (!seed) {
      throw new ValidationError(
        `Pipeline '${id}' is no longer in the built-in catalog, so it cannot be reseeded. Delete it instead.`,
      )
    }
    const labels = existing.labels ?? seed.labels
    const pipeline: Pipeline = {
      ...seed,
      ...(labels && labels.length ? { labels } : { labels: undefined }),
      ...(existing.archived ? { archived: true } : { archived: undefined }),
    }
    await this.pipelineRepository.update(workspaceId, pipeline)
    return pipeline
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    const existing = assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    // Built-in catalog templates are read-only — they can be cloned but never deleted
    // (matching `update`), so the curated palette is always present. Clone to customise.
    if (existing.builtin) {
      throw new ValidationError('Built-in pipelines are read-only and cannot be deleted.')
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
    return pipeline
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
