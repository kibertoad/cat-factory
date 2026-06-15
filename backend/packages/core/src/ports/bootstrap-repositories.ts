import type { BootstrapStatus } from '../domain/types'

// Persistence ports for the repo-bootstrap feature. The worker implements these
// against D1 (migration 0010); tests supply in-memory fakes. All rows are scoped
// by workspace, mirroring the board / GitHub / environment repositories.

/**
 * A managed reference architecture: a base repo new repositories are
 * bootstrapped from, plus default bootstrapper instructions.
 */
export interface ReferenceArchitectureRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  repoOwner: string
  repoName: string
  defaultInstructions: string
  createdAt: number
  updatedAt: number
  /** Set when the entry is removed (tombstone). */
  deletedAt: number | null
}

export type ReferenceArchitectureRecordPatch = Partial<
  Pick<
    ReferenceArchitectureRecord,
    'name' | 'description' | 'repoOwner' | 'repoName' | 'defaultInstructions' | 'updatedAt'
  >
>

export interface ReferenceArchitectureRepository {
  insert(record: ReferenceArchitectureRecord): Promise<void>
  update(workspaceId: string, id: string, patch: ReferenceArchitectureRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<ReferenceArchitectureRecord | null>
  listByWorkspace(workspaceId: string): Promise<ReferenceArchitectureRecord[]>
  softDelete(workspaceId: string, id: string, at: number): Promise<void>
}

/** One "bootstrap repo" run and its outcome, projected locally. */
export interface BootstrapJobRecord {
  id: string
  workspaceId: string
  referenceArchitectureId: string
  referenceArchitectureName: string
  repoName: string
  repoOwner: string | null
  repoUrl: string | null
  instructions: string
  status: BootstrapStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

export type BootstrapJobRecordPatch = Partial<
  Pick<BootstrapJobRecord, 'status' | 'repoOwner' | 'repoUrl' | 'error' | 'updatedAt'>
>

export interface BootstrapJobRepository {
  insert(record: BootstrapJobRecord): Promise<void>
  update(workspaceId: string, id: string, patch: BootstrapJobRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<BootstrapJobRecord | null>
  listByWorkspace(workspaceId: string): Promise<BootstrapJobRecord[]>
}
