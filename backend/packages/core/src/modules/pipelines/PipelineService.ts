import type { CreatePipelineInput } from '@cat-factory/contracts'
import type { Pipeline } from '../../domain/types'
import { assertFound } from '../../domain/errors'
import type { PipelineRepository, WorkspaceRepository } from '../../ports/repositories'
import type { IdGenerator } from '../../ports/runtime'
import { requireWorkspace } from '../workspaces/WorkspaceService'

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
    const pipeline: Pipeline = {
      id: this.idGenerator.next('pl'),
      name: input.name.trim() || 'Untitled pipeline',
      agentKinds: [...input.agentKinds],
    }
    await this.pipelineRepository.insert(workspaceId, pipeline)
    return pipeline
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    assertFound(await this.pipelineRepository.get(workspaceId, id), 'Pipeline', id)
    await this.pipelineRepository.delete(workspaceId, id)
  }
}
