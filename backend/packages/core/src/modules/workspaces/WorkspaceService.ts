import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import type { Workspace, WorkspaceSnapshot } from '../../domain/types'
import { assertFound } from '../../domain/errors'
import { seedBlocks, seedPipelines } from '../../domain/seed'
import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '../../ports/repositories'
import type { Clock, IdGenerator } from '../../ports/runtime'

export interface WorkspaceServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * Resolve a workspace or throw — the shared guard the other module services use
 * before touching a board's contents.
 */
export async function requireWorkspace(
  repository: WorkspaceRepository,
  id: string,
): Promise<Workspace> {
  return assertFound(await repository.get(id), 'Workspace', id)
}

/** Creates, reads and deletes boards (workspaces) and assembles snapshots. */
export class WorkspaceService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    idGenerator,
    clock,
  }: WorkspaceServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
  }

  /**
   * Boards visible to a user. `ownerUserId` is the signed-in user's id, or
   * `null` when auth is disabled (then all boards are returned).
   */
  list(ownerUserId: number | null): Promise<Workspace[]> {
    return this.workspaceRepository.listByOwner(ownerUserId)
  }

  /** Owning user id for a board (number/owned, null/legacy, undefined/missing). */
  ownerOf(id: string): Promise<number | null | undefined> {
    return this.workspaceRepository.ownerOf(id)
  }

  async create(input: CreateWorkspaceInput, ownerUserId: number | null): Promise<WorkspaceSnapshot> {
    const workspace: Workspace = {
      id: this.idGenerator.next('ws'),
      name: input.name?.trim() || 'Untitled board',
      createdAt: this.clock.now(),
    }
    await this.workspaceRepository.create(workspace, ownerUserId)

    if (input.seed ?? true) {
      for (const block of seedBlocks()) {
        await this.blockRepository.insert(workspace.id, block)
      }
      for (const pipeline of seedPipelines()) {
        await this.pipelineRepository.insert(workspace.id, pipeline)
      }
    }
    return this.snapshot(workspace.id)
  }

  require(id: string): Promise<Workspace> {
    return requireWorkspace(this.workspaceRepository, id)
  }

  async snapshot(id: string): Promise<WorkspaceSnapshot> {
    const workspace = await this.require(id)
    const [blocks, pipelines, executions] = await Promise.all([
      this.blockRepository.listByWorkspace(id),
      this.pipelineRepository.listByWorkspace(id),
      this.executionRepository.listByWorkspace(id),
    ])
    return { workspace, blocks, pipelines, executions }
  }

  async delete(id: string): Promise<void> {
    await this.require(id)
    await this.workspaceRepository.delete(id)
  }
}
