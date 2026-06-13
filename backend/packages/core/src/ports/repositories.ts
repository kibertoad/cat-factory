import type { Block, ExecutionInstance, Pipeline, Workspace } from '../domain/types'

// ---------------------------------------------------------------------------
// Repository ports: persistence interfaces the domain layer depends on. The
// worker's infrastructure layer implements them against D1; tests could supply
// in-memory fakes. The domain never imports a concrete adapter, which is what
// keeps this package framework-agnostic.
// ---------------------------------------------------------------------------

export interface WorkspaceRepository {
  list(): Promise<Workspace[]>
  get(id: string): Promise<Workspace | null>
  create(workspace: Workspace): Promise<void>
  delete(id: string): Promise<void>
}

/**
 * Fields of a block that may be patched. Excludes `id`; the `parentId`/`position`
 * structural move is just another patch, kept honest by the adapter.
 */
export type BlockPatch = Partial<Omit<Block, 'id'>>

export interface BlockRepository {
  listByWorkspace(workspaceId: string): Promise<Block[]>
  get(workspaceId: string, id: string): Promise<Block | null>
  insert(workspaceId: string, block: Block): Promise<void>
  update(workspaceId: string, id: string, patch: BlockPatch): Promise<void>
  deleteMany(workspaceId: string, ids: string[]): Promise<void>
}

export interface PipelineRepository {
  listByWorkspace(workspaceId: string): Promise<Pipeline[]>
  get(workspaceId: string, id: string): Promise<Pipeline | null>
  insert(workspaceId: string, pipeline: Pipeline): Promise<void>
  delete(workspaceId: string, id: string): Promise<void>
}

/** A lightweight reference to a run, used by the cron sweeper. */
export interface RunRef {
  workspaceId: string
  id: string
}

export interface ExecutionRepository {
  listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]>
  get(workspaceId: string, id: string): Promise<ExecutionInstance | null>
  getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null>
  upsert(workspaceId: string, execution: ExecutionInstance): Promise<void>
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
  /**
   * Runs still marked `running` whose lease (`updated_at`) is older than the
   * given epoch-ms cutoff — i.e. candidates the durable driver may have dropped.
   * Spans all workspaces so a single cron pass can repair the whole system.
   */
  listStale(olderThanEpochMs: number): Promise<RunRef[]>
  /** Record a terminal agent failure: store `error` and stop the run. */
  markError(workspaceId: string, id: string, error: string): Promise<void>
}
