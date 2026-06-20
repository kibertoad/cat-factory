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
  /**
   * Services by id, in a single (chunked) query. Used to resolve every service a workspace
   * mounts when composing its board, without one round-trip per mount. Empty input → empty.
   */
  listByIds(ids: string[]): Promise<Service[]>
  /** The service linked to a repo (installation + github id), or null. */
  getByRepo(installationId: number, repoGithubId: number): Promise<Service | null>
  insert(service: Service): Promise<void>
  update(id: string, patch: ServicePatch): Promise<void>
  delete(id: string): Promise<void>
  /**
   * Delete a set of services in a single (chunked) query — the batched form of
   * {@link ServiceRepository.delete} used when a frame deletion dooms one or more services at
   * once. Empty input → no-op.
   */
  deleteMany(ids: string[]): Promise<void>
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
  /**
   * The workspace ids that mount the service owning `blockId` (homed in `originWorkspaceId`),
   * resolved in a SINGLE join — the real-time fan-out's hot path. Folds the
   * "block → its service → the workspaces mounting it" lookup into one query instead of
   * resolving the block's service and then its mounts on every event. Empty when the block has
   * no service (the caller then delivers to the origin only). The origin is NOT implied — the
   * caller unions it in.
   */
  listWorkspaceIdsMountingBlock(originWorkspaceId: string, blockId: string): Promise<string[]>
  /**
   * Mount counts for a set of services in a single query, keyed by service id (services with
   * no mounts are absent). Backs the org catalog's "Shared" badge without an N+1
   * {@link WorkspaceMountRepository.listByService} per service on the snapshot hot path.
   */
  countByServiceIds(serviceIds: string[]): Promise<Record<string, number>>
  get(workspaceId: string, serviceId: string): Promise<WorkspaceMount | null>
  upsert(mount: WorkspaceMount): Promise<void>
  update(workspaceId: string, serviceId: string, patch: WorkspaceMountPatch): Promise<void>
  /** Remove a service from a workspace board (does NOT delete the service). */
  remove(workspaceId: string, serviceId: string): Promise<void>
  /**
   * Remove EVERY workspace's mount of the given services in a single (chunked) query — the
   * batched form of {@link WorkspaceMountRepository.remove} used when a frame deletion dooms a
   * service: its mounts must be cleaned off every board at once. Empty input → no-op.
   */
  removeByServices(serviceIds: string[]): Promise<void>
}
