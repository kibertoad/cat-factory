import type {
  ServiceFragmentDefaults,
  ServiceFragmentDefaultsRepository,
  SetServiceFragmentDefaultsInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'

export interface ServiceFragmentDefaultsServiceDependencies {
  serviceFragmentDefaultsRepository: ServiceFragmentDefaultsRepository
  workspaceRepository: WorkspaceRepository
}

/**
 * Read/replace a workspace's default service-fragment selection — the best-practice
 * prompt fragment ids new services inherit (seeded onto a frame's `serviceFragmentIds`
 * at creation). Sending the full list replaces it wholesale.
 */
export class ServiceFragmentDefaultsService {
  private readonly defaults: ServiceFragmentDefaultsRepository
  private readonly workspaceRepository: WorkspaceRepository

  constructor(deps: ServiceFragmentDefaultsServiceDependencies) {
    this.defaults = deps.serviceFragmentDefaultsRepository
    this.workspaceRepository = deps.workspaceRepository
  }

  /** The workspace's default fragment-id list (empty when none set). */
  async get(workspaceId: string): Promise<ServiceFragmentDefaults> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return { fragmentIds: await this.defaults.get(workspaceId) }
  }

  /** Replace the workspace's default fragment-id list and return the stored result. */
  async set(
    workspaceId: string,
    input: SetServiceFragmentDefaultsInput,
  ): Promise<ServiceFragmentDefaults> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.defaults.set(workspaceId, input.fragmentIds)
    return { fragmentIds: input.fragmentIds }
  }
}
