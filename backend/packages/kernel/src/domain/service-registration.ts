import type { Block, Service } from './types.js'
import type {
  Clock,
  IdGenerator,
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '../ports/index.js'

/**
 * The repositories + helpers needed to register a top-level frame as an account-owned
 * service. The service repos are optional so a facade/test without in-org sharing wired
 * keeps the feature cleanly opt-in (registration becomes a no-op).
 */
export interface ServiceRegistrationDeps {
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * Register a newly created top-level frame as an account-owned {@link Service} and mount it
 * onto the creating workspace (in-org sharing), so the frame can be shared with other
 * workspaces in the same org. Returns the new service id to stamp on the frame block (it is
 * then `listByService`-discoverable on every board that mounts the service); the frame's
 * board position is carried on the mount (the per-workspace layout override). Returns
 * undefined — a no-op — when the service repositories aren't wired (legacy/local-only frame).
 *
 * Shared by every site that creates a top-level frame (board drops, repo import, seeded demo
 * boards, repo bootstrap) so they all produce a consistent, shareable service.
 */
export async function registerServiceForFrame(
  deps: ServiceRegistrationDeps,
  workspaceId: string,
  frame: Pick<Block, 'id' | 'position' | 'size'>,
  repo?: { installationId: number; githubId: number; directory?: string | null },
): Promise<string | undefined> {
  const { serviceRepository, workspaceMountRepository } = deps
  if (!serviceRepository || !workspaceMountRepository) return undefined
  const accountId = (await deps.workspaceRepository.accountOf(workspaceId)) ?? null
  const now = deps.clock.now()
  const service: Service = {
    id: deps.idGenerator.next('svc'),
    accountId,
    frameBlockId: frame.id,
    installationId: repo?.installationId ?? null,
    repoGithubId: repo?.githubId ?? null,
    directory: repo?.directory ?? null,
    createdAt: now,
  }
  await serviceRepository.insert(service)
  await workspaceMountRepository.upsert({
    workspaceId,
    serviceId: service.id,
    position: frame.position,
    size: frame.size ?? null,
    createdAt: now,
  })
  return service.id
}
