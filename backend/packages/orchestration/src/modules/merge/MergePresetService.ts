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
  requireWorkspace,
  seedMergePresets,
  ValidationError,
} from '@cat-factory/kernel'
import type { MergePresetSeed } from '@cat-factory/kernel'

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
 * the built-in catalog ({@link seedMergePresets}) on first use, and the default cannot
 * be deleted. The single-default promotion is enforced in the repository. {@link reseed}
 * restores a built-in to the current catalog (adopting an update, repairing drift, or
 * materialising a NEW built-in that appeared after the workspace was created).
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

  /** List a workspace's presets, seeding the built-in catalog if none exist yet. */
  async list(workspaceId: string): Promise<MergeThresholdPreset[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.ensureSeeded(workspaceId)
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
      maxTesterQualityIterations: input.maxTesterQualityIterations,
      releaseWatchWindowMinutes: input.releaseWatchWindowMinutes,
      releaseMaxAttempts: input.releaseMaxAttempts,
      humanReviewGraceMinutes: input.humanReviewGraceMinutes,
      autoMergeEnabled: input.autoMergeEnabled,
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
      ...(patch.maxTesterQualityIterations !== undefined
        ? { maxTesterQualityIterations: patch.maxTesterQualityIterations }
        : {}),
      ...(patch.releaseWatchWindowMinutes !== undefined
        ? { releaseWatchWindowMinutes: patch.releaseWatchWindowMinutes }
        : {}),
      ...(patch.releaseMaxAttempts !== undefined
        ? { releaseMaxAttempts: patch.releaseMaxAttempts }
        : {}),
      ...(patch.humanReviewGraceMinutes !== undefined
        ? { humanReviewGraceMinutes: patch.humanReviewGraceMinutes }
        : {}),
      ...(patch.autoMergeEnabled !== undefined ? { autoMergeEnabled: patch.autoMergeEnabled } : {}),
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

  /**
   * Restore a built-in preset to its current catalog definition ({@link seedMergePresets}).
   * Used to adopt an improved built-in, repair one whose persisted copy drifted, or
   * materialise a NEW built-in that appeared after this workspace was seeded (so it has the
   * old presets but not the new one). The canonical thresholds / `autoMergeEnabled` / `version`
   * overwrite (or create) the stored row; an existing copy's `isDefault` + `createdAt` are
   * preserved so reseeding never silently changes which preset is the default or its ordering.
   * When re-materialising a built-in the workspace had deleted, it only (re)claims the default
   * if the workspace currently has none, so reseeding a default-flagged built-in (e.g.
   * `mp_balanced`) can never steal the default away from the user's chosen preset.
   * Rejects an id not in the catalog (a custom preset — delete it instead).
   */
  async reseed(workspaceId: string, id: string): Promise<MergeThresholdPreset> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const seed = seedMergePresets().find((p) => p.id === id)
    if (!seed) {
      throw new ValidationError(
        `Merge preset '${id}' is not a built-in (or is no longer in the catalog), so it cannot be reseeded. Delete it instead.`,
      )
    }
    const existing = await this.presets.get(workspaceId, id)
    // Keep the user's default choice when the preset already exists. When re-creating a
    // deleted built-in, only let it reclaim default if the workspace has none right now;
    // otherwise the seed's `isDefault` would silently demote the user's chosen default.
    const isDefault = existing
      ? existing.isDefault
      : seed.isDefault && (await this.presets.getDefault(workspaceId)) === null
    const preset: MergeThresholdPreset = {
      ...this.fromSeed(seed),
      isDefault,
      createdAt: existing?.createdAt ?? this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    return preset
  }

  /** Seed the built-in preset catalog for a workspace that has none yet. Idempotent. */
  private async ensureSeeded(workspaceId: string): Promise<void> {
    const current = await this.presets.list(workspaceId)
    if (current.length > 0) return
    const now = this.clock.now()
    // Stamp createdAt by catalog order so `list` (ordered by created_at) preserves it.
    let offset = 0
    for (const seed of seedMergePresets()) {
      await this.presets.upsert(workspaceId, {
        ...this.fromSeed(seed),
        createdAt: now + offset++,
      })
    }
  }

  /** A catalog seed as a persisted preset (its stable id + version, without `createdAt`). */
  private fromSeed(seed: MergePresetSeed): Omit<MergeThresholdPreset, 'createdAt'> {
    return {
      id: seed.id,
      name: seed.name,
      maxComplexity: seed.maxComplexity,
      maxRisk: seed.maxRisk,
      maxImpact: seed.maxImpact,
      ciMaxAttempts: seed.ciMaxAttempts,
      maxRequirementIterations: seed.maxRequirementIterations,
      maxRequirementConcernAllowed: seed.maxRequirementConcernAllowed,
      maxTesterQualityIterations: seed.maxTesterQualityIterations,
      releaseWatchWindowMinutes: seed.releaseWatchWindowMinutes,
      releaseMaxAttempts: seed.releaseMaxAttempts,
      humanReviewGraceMinutes: seed.humanReviewGraceMinutes,
      autoMergeEnabled: seed.autoMergeEnabled,
      isDefault: seed.isDefault,
      version: seed.version,
    }
  }
}
