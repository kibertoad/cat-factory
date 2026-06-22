import type {
  ClonePipelineInput,
  CreatePipelineInput,
  UpdatePipelineInput,
} from '@cat-factory/contracts'
import type { Pipeline } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import type { PipelineRepository, WorkspaceRepository } from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import { companionTargets, isCompanionKind } from '@cat-factory/agents'

export interface PipelineServiceDependencies {
  workspaceRepository: WorkspaceRepository
  pipelineRepository: PipelineRepository
  idGenerator: IdGenerator
}

/** Saved, reusable pipelines (the pipeline palette). */
export class PipelineService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly idGenerator: IdGenerator

  constructor({
    workspaceRepository,
    pipelineRepository,
    idGenerator,
  }: PipelineServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.pipelineRepository = pipelineRepository
    this.idGenerator = idGenerator
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
    assertValidCompanionPlacement(input.agentKinds, input.enabled)
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name.trim() || 'Untitled pipeline',
      agentKinds: [...input.agentKinds],
      ...alignedGates(input.agentKinds, input.gates),
      ...alignedThresholds(input.agentKinds, input.thresholds),
      ...alignedEnabled(input.agentKinds, input.enabled),
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
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name?.trim() || `${source.name} (copy)`,
      agentKinds: [...source.agentKinds],
      ...(source.gates ? { gates: [...source.gates] } : {}),
      ...(source.thresholds ? { thresholds: [...source.thresholds] } : {}),
      ...(source.enabled ? { enabled: [...source.enabled] } : {}),
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
    assertSomeEnabled(agentKinds, enabled)
    // Re-validate companion placement against the EFFECTIVE (enabled) chain — disabling
    // a producer while leaving its companion on would orphan the companion — so validate
    // whenever the chain OR the enable flags change, not just on a chain replacement.
    if (input.agentKinds || input.enabled) assertValidCompanionPlacement(agentKinds, enabled)
    const pipeline: Pipeline = {
      id: existing.id,
      name: input.name?.trim() || existing.name,
      agentKinds: [...agentKinds],
      ...alignedGates(agentKinds, gates),
      ...alignedThresholds(agentKinds, thresholds),
      ...alignedEnabled(agentKinds, enabled),
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

/** A pipeline with every step disabled would have nothing to run. */
function assertSomeEnabled(agentKinds: string[], enabled: boolean[] | undefined): void {
  if (!enabled) return
  if (!agentKinds.some((_, i) => enabled[i] ?? true)) {
    throw new ValidationError('A pipeline must keep at least one step enabled.')
  }
}

/**
 * A companion step is only valid when some earlier step produces output it is allowed
 * to review (a step whose kind is in the companion's target allow-list). Throws a
 * {@link ValidationError} on a misplaced companion so the builder can't save one that
 * would have nothing to grade at runtime.
 *
 * `enabled` is the (optional) per-step enable mask: only ENABLED steps actually run, so
 * the run is built from them alone. A disabled companion never runs (skipped), and a
 * disabled producer can't be the thing a companion grades — so the check is performed
 * over the enabled subset. This rejects "disable the producer but leave its companion
 * on", which would otherwise leave the companion grading nothing at runtime.
 */
function assertValidCompanionPlacement(agentKinds: string[], enabled?: boolean[]): void {
  const isEnabled = (i: number) => enabled?.[i] !== false
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || !isCompanionKind(kind)) continue
    if (!isEnabled(i)) continue
    const targets = companionTargets(kind)
    const hasProducer = agentKinds
      .slice(0, i)
      .some((k, j) => targets.includes(k) && isEnabled(j))
    if (!hasProducer) {
      throw new ValidationError(
        `Companion '${kind}' must run after an enabled step it can review (${targets.join(', ')}).`,
      )
    }
  }
}
