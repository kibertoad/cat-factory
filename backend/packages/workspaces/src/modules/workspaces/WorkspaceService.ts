import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import { requireWorkspace, seedBlocks, seedPipelines } from '@cat-factory/kernel'
import type { Workspace, WorkspaceSnapshot } from '@cat-factory/kernel'
import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'

export { requireWorkspace } from '@cat-factory/kernel'

export interface WorkspaceServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  clock: Clock
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
   * Boards visible to a user (see {@link WorkspaceVisibility}). A `null` scope
   * means auth is disabled and all boards are returned.
   */
  list(scope: WorkspaceVisibility): Promise<Workspace[]> {
    return this.workspaceRepository.listVisible(scope)
  }

  /** Owning user id for a board (number/owned, null/none, undefined/missing). */
  ownerOf(id: string): Promise<number | null | undefined> {
    return this.workspaceRepository.ownerOf(id)
  }

  /** Owning account id for a board (string/scoped, null/legacy, undefined/missing). */
  accountOf(id: string): Promise<string | null | undefined> {
    return this.workspaceRepository.accountOf(id)
  }

  async create(
    input: CreateWorkspaceInput,
    ownerUserId: number | null,
    accountId: string | null,
  ): Promise<WorkspaceSnapshot> {
    const workspace: Workspace = {
      id: this.idGenerator.next('ws'),
      name: input.name?.trim() || 'Untitled board',
      createdAt: this.clock.now(),
      accountId,
    }
    await this.workspaceRepository.create(workspace, ownerUserId, accountId)

    // The built-in pipeline catalog is product configuration, not sample data, so
    // every board gets it — including the empty boards real users start with.
    for (const pipeline of seedPipelines()) {
      await this.pipelineRepository.insert(workspace.id, pipeline)
    }
    // The sample architecture blocks are opt-in (demo boards + the test fixtures);
    // production boards start empty (the SPA creates with `seed: false`).
    if (input.seed ?? true) {
      for (const block of seedBlocks()) {
        await this.blockRepository.insert(workspace.id, block)
      }
    }
    return this.snapshot(workspace.id)
  }

  /** Rename a board. */
  async rename(id: string, name: string): Promise<Workspace> {
    await this.require(id)
    await this.workspaceRepository.rename(id, name.trim())
    return this.require(id)
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
