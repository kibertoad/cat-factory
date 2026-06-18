import type { BlueprintService, BlueprintSource } from '../domain/types'

// Persistence port for the board-scan feature. The worker implements it against
// D1 (migration 0011); tests supply an in-memory fake. Rows are scoped by
// workspace, mirroring the board / GitHub / bootstrap repositories. Exactly one
// blueprint is kept per (workspace, repo): a re-scan replaces it in place, so the
// map stays the single current decomposition rather than an append-only log.

/** A persisted repository blueprint (the decomposition tree, projected locally). */
export interface RepoBlueprintRecord {
  id: string
  workspaceId: string
  repoOwner: string
  repoName: string
  source: BlueprintSource
  /** The service → modules tree. */
  service: BlueprintService
  createdAt: number
  updatedAt: number
}

export interface RepoBlueprintRepository {
  /** Insert or replace the blueprint for this (workspace, repo). */
  upsert(record: RepoBlueprintRecord): Promise<void>
  get(workspaceId: string, id: string): Promise<RepoBlueprintRecord | null>
  /** The current blueprint for a repo, if one has been scanned. */
  getByRepo(
    workspaceId: string,
    repoOwner: string,
    repoName: string,
  ): Promise<RepoBlueprintRecord | null>
  listByWorkspace(workspaceId: string): Promise<RepoBlueprintRecord[]>
  delete(workspaceId: string, id: string): Promise<void>
}
