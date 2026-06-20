import type {
  MountServiceInput,
  Service,
  UpdateMountInput,
  WorkspaceMount,
} from '@cat-factory/kernel'
import {
  type Clock,
  type IdGenerator,
  type ServiceRepository,
  type WorkspaceMountRepository,
  type WorkspaceRepository,
  ValidationError,
  assertFound,
  requireWorkspace,
} from '@cat-factory/kernel'

export interface ServiceMountServiceDependencies {
  serviceRepository: ServiceRepository
  workspaceMountRepository: WorkspaceMountRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * In-org service sharing: list an account's services (the catalog a workspace mounts
 * from) and mount / unmount / re-layout them on a workspace board. A *mount* places a
 * shared service onto a board with a per-workspace layout override; the service itself —
 * its subtree, state and sync — stays canonical and account-owned. Unmounting only
 * removes the service from that board; it never deletes the service.
 *
 * Sharing is strictly within one account: a workspace may only mount services owned by
 * the same account it belongs to (enforced here), so a shared service can never leak
 * across org boundaries.
 */
export class ServiceMountService {
  private readonly serviceRepository: ServiceRepository
  private readonly workspaceMountRepository: WorkspaceMountRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock

  constructor(deps: ServiceMountServiceDependencies) {
    this.serviceRepository = deps.serviceRepository
    this.workspaceMountRepository = deps.workspaceMountRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
  }

  /**
   * The org catalog: every service owned by an account (or the legacy/unscoped org when
   * `accountId` is null) — the set a workspace in that org can mount from. Each service is
   * annotated with `mountCount` (how many boards mount it) so the UI can badge a shared one.
   */
  async listForAccount(accountId: string | null): Promise<Service[]> {
    const services = await this.serviceRepository.listByAccount(accountId)
    return Promise.all(
      services.map(async (service) => ({
        ...service,
        mountCount: (await this.workspaceMountRepository.listByService(service.id)).length,
      })),
    )
  }

  /** Services currently mounted onto a workspace board (with their layout overrides). */
  async listMounts(workspaceId: string): Promise<WorkspaceMount[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return this.workspaceMountRepository.listByWorkspace(workspaceId)
  }

  /**
   * Mount an existing org service onto a workspace board. The service must belong to
   * the same account as the workspace (no cross-org sharing). Idempotent: re-mounting
   * an already-mounted service just returns the existing mount.
   */
  async mount(
    workspaceId: string,
    serviceId: string,
    input: MountServiceInput = {},
  ): Promise<WorkspaceMount> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const service = assertFound(await this.serviceRepository.get(serviceId), 'Service', serviceId)
    const account = await this.workspaceRepository.accountOf(workspaceId)
    // Both account-scoped and both the same account; the legacy/unscoped (NULL) path
    // only ever sees its own services, which also share the NULL account.
    if ((account ?? null) !== (service.accountId ?? null)) {
      throw new ValidationError('A service can only be mounted within its own organization')
    }
    const existing = await this.workspaceMountRepository.get(workspaceId, serviceId)
    if (existing) return existing
    const mount: WorkspaceMount = {
      workspaceId,
      serviceId,
      position: input.position ?? this.defaultPosition(await this.listMounts(workspaceId)),
      size: null,
      createdAt: this.clock.now(),
    }
    await this.workspaceMountRepository.upsert(mount)
    return mount
  }

  /** Remove a service from a workspace board (does NOT delete the shared service). */
  async unmount(workspaceId: string, serviceId: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.workspaceMountRepository.remove(workspaceId, serviceId)
  }

  /** Update a mount's per-workspace layout override (frame position/size). */
  async updateLayout(
    workspaceId: string,
    serviceId: string,
    patch: UpdateMountInput,
  ): Promise<WorkspaceMount> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    assertFound(
      await this.workspaceMountRepository.get(workspaceId, serviceId),
      'WorkspaceMount',
      serviceId,
    )
    await this.workspaceMountRepository.update(workspaceId, serviceId, patch)
    return assertFound(
      await this.workspaceMountRepository.get(workspaceId, serviceId),
      'WorkspaceMount',
      serviceId,
    )
  }

  private defaultPosition(existing: WorkspaceMount[]): { x: number; y: number } {
    const n = existing.length
    return { x: 80 + (n % 5) * 48, y: 80 + (n % 5) * 48 }
  }
}
