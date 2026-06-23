import type {
  Clock,
  CreateMergePresetInput,
  IdGenerator,
  MergePresetRepository,
  MergeThresholdPreset,
  UpdateMergePresetInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  DEFAULT_MERGE_PRESET,
  requireWorkspace,
} from '@cat-factory/kernel'

export interface MergePresetServiceDependencies {
  mergePresetRepository: MergePresetRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * CRUD for a workspace's merge threshold presets (the library a task picks its
 * auto-merge policy from). Maintains the invariant that a workspace always has at
 * least one preset, exactly one of which is the default: {@link list} lazily seeds
 * the built-in {@link DEFAULT_MERGE_PRESET} on first use, and the default cannot be
 * deleted. The single-default promotion is enforced in the repository.
 */
export class MergePresetService {
  private readonly presets: MergePresetRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock

  constructor(deps: MergePresetServiceDependencies) {
    this.presets = deps.mergePresetRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
  }

  /** List a workspace's presets, seeding the built-in default if none exist yet. */
  async list(workspaceId: string): Promise<MergeThresholdPreset[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.ensureDefault(workspaceId)
    return this.presets.list(workspaceId)
  }

  /** Create a new preset. The first one (or one flagged default) becomes the default. */
  async create(workspaceId: string, input: CreateMergePresetInput): Promise<MergeThresholdPreset> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.list(workspaceId)
    const preset: MergeThresholdPreset = {
      id: this.idGenerator.next('mp'),
      name: input.name,
      maxComplexity: input.maxComplexity,
      maxRisk: input.maxRisk,
      maxImpact: input.maxImpact,
      ciMaxAttempts: input.ciMaxAttempts,
      maxRequirementIterations: input.maxRequirementIterations,
      maxRequirementConcernAllowed: input.maxRequirementConcernAllowed,
      releaseWatchWindowMinutes: input.releaseWatchWindowMinutes,
      releaseMaxAttempts: input.releaseMaxAttempts,
      // The very first preset must be the default; otherwise honour the request.
      isDefault: existing.length === 0 ? true : input.isDefault,
      createdAt: this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    return preset
  }

  /** Patch a preset. Demoting the only default is rejected (one must remain). */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateMergePresetInput,
  ): Promise<MergeThresholdPreset> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.presets.get(workspaceId, id), 'MergePreset', id)
    if (existing.isDefault && patch.isDefault === false) {
      throw new ConflictError('Cannot unset the default preset; promote another preset instead.')
    }
    const updated: MergeThresholdPreset = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.maxComplexity !== undefined ? { maxComplexity: patch.maxComplexity } : {}),
      ...(patch.maxRisk !== undefined ? { maxRisk: patch.maxRisk } : {}),
      ...(patch.maxImpact !== undefined ? { maxImpact: patch.maxImpact } : {}),
      ...(patch.ciMaxAttempts !== undefined ? { ciMaxAttempts: patch.ciMaxAttempts } : {}),
      ...(patch.maxRequirementIterations !== undefined
        ? { maxRequirementIterations: patch.maxRequirementIterations }
        : {}),
      ...(patch.maxRequirementConcernAllowed !== undefined
        ? { maxRequirementConcernAllowed: patch.maxRequirementConcernAllowed }
        : {}),
      ...(patch.releaseWatchWindowMinutes !== undefined
        ? { releaseWatchWindowMinutes: patch.releaseWatchWindowMinutes }
        : {}),
      ...(patch.releaseMaxAttempts !== undefined
        ? { releaseMaxAttempts: patch.releaseMaxAttempts }
        : {}),
      ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
    }
    await this.presets.upsert(workspaceId, updated)
    return updated
  }

  /** Remove a preset. The default preset cannot be removed. */
  async remove(workspaceId: string, id: string): Promise<void> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.get(workspaceId, id)
    if (existing?.isDefault) {
      throw new ConflictError('Cannot delete the default preset; promote another preset first.')
    }
    await this.presets.remove(workspaceId, id)
  }

  /** Seed the built-in default preset for a workspace that has none yet. Idempotent. */
  private async ensureDefault(workspaceId: string): Promise<void> {
    const current = await this.presets.list(workspaceId)
    if (current.length > 0) return
    await this.presets.upsert(workspaceId, {
      id: this.idGenerator.next('mp'),
      name: DEFAULT_MERGE_PRESET.name,
      maxComplexity: DEFAULT_MERGE_PRESET.maxComplexity,
      maxRisk: DEFAULT_MERGE_PRESET.maxRisk,
      maxImpact: DEFAULT_MERGE_PRESET.maxImpact,
      ciMaxAttempts: DEFAULT_MERGE_PRESET.ciMaxAttempts,
      maxRequirementIterations: DEFAULT_MERGE_PRESET.maxRequirementIterations,
      maxRequirementConcernAllowed: DEFAULT_MERGE_PRESET.maxRequirementConcernAllowed,
      releaseWatchWindowMinutes: DEFAULT_MERGE_PRESET.releaseWatchWindowMinutes,
      releaseMaxAttempts: DEFAULT_MERGE_PRESET.releaseMaxAttempts,
      isDefault: true,
      createdAt: this.clock.now(),
    })
  }
}
