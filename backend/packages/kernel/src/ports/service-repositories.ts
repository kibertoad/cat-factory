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
export type ServicePatch = Partial<
  Pick<Service, 'accountId' | 'installationId' | 'repoGithubId' | 'directory'>
>

export interface ServiceRepository {
  get(id: string): Promise<Service | null>
  /** The service that owns a given frame block, or null. */
  getByFrameBlock(frameBlockId: string): Promise<Service | null>
  /**
   * The services owning the given frame blocks, in a single (chunked) query — the batched form
   * of {@link ServiceRepository.getByFrameBlock} used when resolving many frames at once (e.g. a
   * board's duplicate-service check or a frame-subtree deletion), without one round-trip per
   * frame. Empty input → empty.
   */
  listByFrameBlocks(frameBlockIds: string[]): Promise<Service[]>
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
  /** Subjects mounted onto a workspace board (with their layout overrides). */
  listByWorkspace(workspaceId: string): Promise<WorkspaceMount[]>
  /**
   * Every mount of ANY of the given subjects, in a single (chunked) query. Backs the
   * workspace-delete re-home decision (which surviving board still mounts each homed subject)
   * without an N+1 per subject. Empty input gives an empty result.
   */
  listBySubjectIds(subjectIds: string[]): Promise<WorkspaceMount[]>
  /**
   * The workspace ids that mount the subject owning `blockId` (homed in `originWorkspaceId`),
   * resolved in a SINGLE join: the real-time fan-out's hot path. Empty when the block has no
   * owner (the caller then delivers to the origin only). The origin is NOT implied; the caller
   * unions it in.
   */
  listWorkspaceIdsMountingBlock(originWorkspaceId: string, blockId: string): Promise<string[]>
  /**
   * Mount counts for a set of subjects in a single query, keyed by subject id (subjects with no
   * mounts are absent). Backs the org catalog's "Shared" badge without an N+1 per-subject read on
   * the snapshot hot path.
   */
  countBySubjectIds(subjectIds: string[]): Promise<Record<string, number>>
  get(workspaceId: string, subjectId: string): Promise<WorkspaceMount | null>
  upsert(mount: WorkspaceMount): Promise<void>
  update(workspaceId: string, subjectId: string, patch: WorkspaceMountPatch): Promise<void>
  /** Remove a subject from a workspace board (does NOT delete the subject). */
  remove(workspaceId: string, subjectId: string): Promise<void>
  /**
   * Remove EVERY workspace's mount of the given subjects in a single (chunked) query: used when a
   * frame deletion dooms a subject, so its mounts are cleaned off every board at once. Empty
   * input is a no-op.
   */
  removeBySubjects(subjectIds: string[]): Promise<void>
}
