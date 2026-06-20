import type { Service, WorkspaceMount } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence ports for in-org shared services.
//
// A `Service` is account-owned (keyed by its own global id); a `WorkspaceMount`
// places a service onto a workspace board (keyed by (workspace_id, service_id))
// and carries the per-workspace layout override. These are the seam that lets
// the same service appear on several workspaces in one org without duplicating
// its subtree, state or sync.
// ---------------------------------------------------------------------------

/** Fields of a service that may be patched (its id and frame are immutable). */
export type ServicePatch = Partial<Pick<Service, 'accountId' | 'installationId' | 'repoGithubId'>>

export interface ServiceRepository {
  get(id: string): Promise<Service | null>
  /** The service that owns a given frame block, or null. */
  getByFrameBlock(frameBlockId: string): Promise<Service | null>
  /**
   * Every service owned by an account (the org catalog a workspace mounts from).
   * `null` lists the legacy/unscoped org (the auth-disabled path), matching services
   * whose `accountId` is NULL.
   */
  listByAccount(accountId: string | null): Promise<Service[]>
  /** The service linked to a repo (installation + github id), or null. */
  getByRepo(installationId: number, repoGithubId: number): Promise<Service | null>
  insert(service: Service): Promise<void>
  update(id: string, patch: ServicePatch): Promise<void>
  delete(id: string): Promise<void>
}

/** Fields of a mount that may be patched (the per-workspace layout override). */
export type WorkspaceMountPatch = Partial<Pick<WorkspaceMount, 'position' | 'size'>>

export interface WorkspaceMountRepository {
  /** Services mounted onto a workspace board (with their layout overrides). */
  listByWorkspace(workspaceId: string): Promise<WorkspaceMount[]>
  /**
   * Workspaces a service is mounted onto — used to fan real-time events out to
   * every board that shows the changed service.
   */
  listByService(serviceId: string): Promise<WorkspaceMount[]>
  get(workspaceId: string, serviceId: string): Promise<WorkspaceMount | null>
  upsert(mount: WorkspaceMount): Promise<void>
  update(workspaceId: string, serviceId: string, patch: WorkspaceMountPatch): Promise<void>
  /** Remove a service from a workspace board (does NOT delete the service). */
  remove(workspaceId: string, serviceId: string): Promise<void>
}
