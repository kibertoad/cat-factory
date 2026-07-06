import type {
  Clock,
  CreateModelPresetInput,
  IdGenerator,
  ModelPreset,
  ModelPresetRepository,
  UpdateModelPresetInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  DEFAULT_MODEL_PRESET_ID,
  modelForKindFromPreset,
  requireWorkspace,
  seedModelPresets,
  ValidationError,
} from '@cat-factory/kernel'
import type { ModelPresetSeed } from '@cat-factory/kernel'

export interface ModelPresetServiceDependencies {
  modelPresetRepository: ModelPresetRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The catalog id of the built-in preset a fresh workspace is seeded with as its
   * DEFAULT (Cloudflare/Node → `mdp_kimi`, local → `mdp_claude`). Deployment-level,
   * applied only at first seed (an empty library), so a user's later manual default
   * choice is always preserved. Defaults to {@link DEFAULT_MODEL_PRESET_ID} (Kimi).
   */
  defaultPresetId?: string
}

/**
 * CRUD for a workspace's model presets (the library a task picks its model→agent
 * mapping from). A preset is one `baseModelId` applied to every agent kind plus
 * per-kind `overrides`. Maintains the invariant that a workspace always has at least
 * one preset, exactly one of which is the default: {@link list} lazily seeds the
 * built-in catalog ({@link seedModelPresets}: Kimi K2.7, GLM-5.2, Claude Opus 4.8) on
 * first use, with the deployment's {@link ModelPresetServiceDependencies.defaultPresetId}
 * flagged default, and the default cannot be deleted. The single-default promotion is
 * enforced in the repository. {@link reseed} restores a built-in to the current catalog
 * (adopting an update, repairing drift, or materialising a NEW built-in that appeared
 * after the workspace was created).
 */
export class ModelPresetService {
  private readonly presets: ModelPresetRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly defaultPresetId: string

  constructor(deps: ModelPresetServiceDependencies) {
    this.presets = deps.modelPresetRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.defaultPresetId = deps.defaultPresetId ?? DEFAULT_MODEL_PRESET_ID
  }

  /** List a workspace's presets, seeding the built-in presets if none exist yet. */
  async list(workspaceId: string): Promise<ModelPreset[]> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    await this.ensureSeeded(workspaceId)
    return this.presets.list(workspaceId)
  }

  /** Create a new preset. The first one (or one flagged default) becomes the default. */
  async create(workspaceId: string, input: CreateModelPresetInput): Promise<ModelPreset> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = await this.presets.list(workspaceId)
    const preset: ModelPreset = {
      id: this.idGenerator.next('mdp'),
      name: input.name,
      baseModelId: input.baseModelId,
      overrides: input.overrides,
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
    patch: UpdateModelPresetInput,
  ): Promise<ModelPreset> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const existing = assertFound(await this.presets.get(workspaceId, id), 'ModelPreset', id)
    if (existing.isDefault && patch.isDefault === false) {
      throw new ConflictError('Cannot unset the default preset; promote another preset instead.')
    }
    const updated: ModelPreset = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.baseModelId !== undefined ? { baseModelId: patch.baseModelId } : {}),
      ...(patch.overrides !== undefined ? { overrides: patch.overrides } : {}),
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
   * Restore a built-in preset to its current catalog definition ({@link seedModelPresets}).
   * Used to adopt an improved built-in, repair one whose persisted copy drifted, or
   * materialise a NEW built-in that appeared after this workspace was seeded (so it has the
   * old presets but not the new one). The canonical base model / overrides / `version`
   * overwrite (or create) the stored row; an existing copy's `isDefault` + `createdAt` are
   * preserved so reseeding never silently changes which preset is the default or its ordering.
   * When re-materialising a built-in the workspace had deleted, it only (re)claims the default
   * if the seed is THIS deployment's default preset AND the workspace currently has none — so
   * reseeding never steals the default away from the user's chosen preset. Rejects an id not in
   * the catalog (a custom preset — delete it instead).
   */
  async reseed(workspaceId: string, id: string): Promise<ModelPreset> {
    await requireWorkspace(this.workspaceRepository, workspaceId)
    const seed = seedModelPresets().find((p) => p.id === id)
    if (!seed) {
      throw new ValidationError(
        `Model preset '${id}' is not a built-in (or is no longer in the catalog), so it cannot be reseeded. Delete it instead.`,
      )
    }
    const existing = await this.presets.get(workspaceId, id)
    // Keep the user's default choice when the preset already exists. When re-creating a
    // deleted built-in, only let it reclaim default if it is this deployment's default preset
    // AND the workspace has none right now; otherwise the seed would silently demote the
    // user's chosen default.
    const isDefault = existing
      ? existing.isDefault
      : seed.id === this.defaultPresetId && (await this.presets.getDefault(workspaceId)) === null
    const preset: ModelPreset = {
      ...this.fromSeed(seed),
      isDefault,
      createdAt: existing?.createdAt ?? this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    return preset
  }

  /**
   * Seed the built-in preset catalog for a workspace that has none yet. Idempotent and
   * safe under concurrent first-reads: each seed gets its STABLE catalog id (`mdp_kimi`
   * …), so two readers racing to seed upsert onto the same rows (ON CONFLICT) rather than
   * creating duplicate built-ins, and a stored copy can later be matched + reseeded.
   * User-created presets use random ids, so they never collide with these. The deployment's
   * {@link defaultPresetId} is flagged default here — applied ONLY on this first empty-library
   * seed, so a user's later manual default choice always survives.
   */
  private async ensureSeeded(workspaceId: string): Promise<void> {
    const current = await this.presets.list(workspaceId)
    if (current.length > 0) return
    const now = this.clock.now()
    // Stamp createdAt by catalog order so `list` (ordered by created_at) preserves it.
    let offset = 0
    for (const seed of seedModelPresets()) {
      await this.presets.upsert(workspaceId, {
        ...this.fromSeed(seed),
        isDefault: seed.id === this.defaultPresetId,
        createdAt: now + offset++,
      })
    }
  }

  /** A catalog seed as a persisted preset (its stable id + version, without `createdAt`/default). */
  private fromSeed(seed: ModelPresetSeed): Omit<ModelPreset, 'createdAt' | 'isDefault'> {
    return {
      id: seed.id,
      name: seed.name,
      baseModelId: seed.baseModelId,
      overrides: { ...seed.overrides },
      version: seed.version,
    }
  }
}

/**
 * The model id an agent kind resolves to under a workspace's presets: the selected
 * preset (by id) else the workspace default, mapped via `overrides[kind] ??
 * baseModelId`. Falls back to the built-in default preset (everything Kimi K2.7) when
 * the library is not yet seeded, so the default holds without a write. Side-effect-free
 * (never seeds), so it's safe on the hot dispatch path. Shared by both runtime facades
 * to back `resolveWorkspaceModelDefault`.
 */
export async function resolvePresetModelForKind(
  repo: ModelPresetRepository,
  workspaceId: string,
  agentKind: string,
  modelPresetId?: string,
): Promise<string> {
  const preset =
    (modelPresetId ? await repo.get(workspaceId, modelPresetId) : null) ??
    (await repo.getDefault(workspaceId))
  return modelForKindFromPreset(preset, agentKind)
}
