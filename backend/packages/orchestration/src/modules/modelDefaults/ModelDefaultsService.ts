import type {
  ModelDefaults,
  ModelDefaultsRepository,
  SetModelDefaultsInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'

export interface ModelDefaultsServiceDependencies {
  modelDefaultsRepository: ModelDefaultsRepository
  workspaceRepository: WorkspaceRepository
}

/**
 * Read/replace a workspace's per-agent-kind default models (the model each agent
 * kind defaults to, overriding the env routing for that workspace). The map is
 * keyed by agent kind and valued by a model catalog id; sending the full map
 * replaces it wholesale (a kind omitted is cleared). A kind absent from the map
 * falls back to the env routing for that kind at run time.
 */
export class ModelDefaultsService {
  private readonly defaults: ModelDefaultsRepository
  private readonly workspaceRepository: WorkspaceRepository

  constructor(deps: ModelDefaultsServiceDependencies) {
    this.defaults = deps.modelDefaultsRepository
    this.workspaceRepository = deps.workspaceRepository
  }

  /** The workspace's per-kind default map (empty when none set). */
  async get(workspaceId: string): Promise<ModelDefaults> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    return { defaults: await this.defaults.get(workspaceId) }
  }

  /** Replace the workspace's per-kind default map and return the stored result. */
  async set(workspaceId: string, input: SetModelDefaultsInput): Promise<ModelDefaults> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.defaults.replace(workspaceId, input.defaults)
    return { defaults: input.defaults }
  }
}
