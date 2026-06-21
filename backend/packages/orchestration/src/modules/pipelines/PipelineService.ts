import type { CreatePipelineInput } from '@cat-factory/contracts'
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
    assertValidCompanionPlacement(input.agentKinds)
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name.trim() || 'Untitled pipeline',
      agentKinds: [...input.agentKinds],
      // Keep gates aligned to agentKinds; only persist when at least one step is
      // gated so an all-false / absent array stays null (a straight-through run).
      ...(input.gates?.some(Boolean)
        ? { gates: input.agentKinds.map((_, i) => input.gates?.[i] ?? false) }
        : {}),
      // Keep thresholds aligned to agentKinds; only persist when at least one step
      // sets an explicit value (else companions fall back to their default bar).
      ...(input.thresholds?.some((t) => t != null)
        ? { thresholds: input.agentKinds.map((_, i) => input.thresholds?.[i] ?? null) }
        : {}),
    }
    await this.pipelineRepository.insert(workspaceId, pipeline)
    return pipeline
  }

  // (helper hoisted to module scope below)

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    await this.pipelineRepository.delete(workspaceId, id)
  }
}

/**
 * A companion step is only valid when some earlier step produces output it is allowed
 * to review (a step whose kind is in the companion's target allow-list). Throws a
 * {@link ValidationError} on a misplaced companion so the builder can't save one that
 * would have nothing to grade at runtime.
 */
function assertValidCompanionPlacement(agentKinds: string[]): void {
  for (let i = 0; i < agentKinds.length; i++) {
    const kind = agentKinds[i]
    if (kind === undefined || !isCompanionKind(kind)) continue
    const targets = companionTargets(kind)
    const hasProducer = agentKinds.slice(0, i).some((k) => targets.includes(k))
    if (!hasProducer) {
      throw new ValidationError(
        `Companion '${kind}' must be placed after a step it can review (${targets.join(', ')}).`,
      )
    }
  }
}
