import type {
  ClonePipelineInput,
  CreatePipelineInput,
  OrganizePipelineInput,
  UpdatePipelineInput,
} from '@cat-factory/contracts'
import type { ConsensusStepConfig, Pipeline, StepGating } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import type {
  DatadogConnectionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import { validatePipelineShape } from './pipelineShape.js'

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
   * Resolves whether the workspace has any observability integration enabled (today: a
   * Datadog connection). When absent (no observability persistence wired at all), the
   * observability-gated step can never be added.
   */
  datadogConnectionRepository?: DatadogConnectionRepository
}

/** Saved, reusable pipelines (the pipeline palette). */
export class PipelineService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly idGenerator: IdGenerator
  private readonly datadogConnectionRepository?: DatadogConnectionRepository

  constructor({
    workspaceRepository,
    pipelineRepository,
    idGenerator,
    datadogConnectionRepository,
  }: PipelineServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.pipelineRepository = pipelineRepository
    this.idGenerator = idGenerator
    this.datadogConnectionRepository = datadogConnectionRepository
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
    const connection = await this.datadogConnectionRepository?.get(workspaceId)
    if (!connection) {
      throw new ValidationError(
        `The '${OBSERVABILITY_GATED_KIND}' step needs an observability integration. Connect Datadog for this workspace first.`,
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
    })
    await this.assertObservabilityGatedStepAllowed(workspaceId, input.agentKinds, input.enabled)
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name.trim() || 'Untitled pipeline',
      agentKinds: [...input.agentKinds],
      ...alignedGates(input.agentKinds, input.gates),
      ...alignedThresholds(input.agentKinds, input.thresholds),
      ...alignedEnabled(input.agentKinds, input.enabled),
      ...alignedConsensus(input.agentKinds, input.consensus),
      ...alignedGating(input.agentKinds, input.gating),
      ...normalizedLabels(input.labels),
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
    })
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name?.trim() || `${source.name} (copy)`,
      agentKinds: [...source.agentKinds],
      ...(source.gates ? { gates: [...source.gates] } : {}),
      ...(source.thresholds ? { thresholds: [...source.thresholds] } : {}),
      ...(source.enabled ? { enabled: [...source.enabled] } : {}),
      ...(source.consensus ? { consensus: [...source.consensus] } : {}),
      ...(source.gating ? { gating: [...source.gating] } : {}),
      ...(source.labels ? { labels: [...source.labels] } : {}),
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
    const labels = input.labels ?? existing.labels
    assertSomeEnabled(agentKinds, enabled)
    // Re-validate the shape against the EFFECTIVE (enabled) chain — disabling a producer
    // while leaving its companion on would orphan the companion, and adding gating without
    // an estimator is illegal — so validate whenever the chain, enable flags, OR gating
    // change, not just on a chain replacement.
    if (input.agentKinds || input.enabled || input.gating) {
      validatePipelineShape({ agentKinds, enabled, gating })
      await this.assertObservabilityGatedStepAllowed(workspaceId, agentKinds, enabled)
    }
    const pipeline: Pipeline = {
      id: existing.id,
      name: input.name?.trim() || existing.name,
      agentKinds: [...agentKinds],
      ...alignedGates(agentKinds, gates),
      ...alignedThresholds(agentKinds, thresholds),
      ...alignedEnabled(agentKinds, enabled),
      ...alignedConsensus(agentKinds, consensus),
      ...alignedGating(agentKinds, gating),
      ...normalizedLabels(labels),
      // `archived` is organization-only state, mutated via `organize` — preserved here.
      ...(existing.archived ? { archived: true } : {}),
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

/** A pipeline with every step disabled would have nothing to run. */
function assertSomeEnabled(agentKinds: string[], enabled: boolean[] | undefined): void {
  if (!enabled) return
  if (!agentKinds.some((_, i) => enabled[i] ?? true)) {
    throw new ValidationError('A pipeline must keep at least one step enabled.')
  }
}
