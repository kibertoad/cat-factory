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
  DEFAULT_MODEL_PRESETS,
  modelForKindFromPreset,
  requireWorkspace,
} from '@cat-factory/kernel'

export interface ModelPresetServiceDependencies {
  modelPresetRepository: ModelPresetRepository
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
}

/**
 * CRUD for a workspace's model presets (the library a task picks its model→agent
 * mapping from). A preset is one `baseModelId` applied to every agent kind plus
 * per-kind `overrides`. Maintains the invariant that a workspace always has at least
 * one preset, exactly one of which is the default: {@link list} lazily seeds the
 * built-in {@link DEFAULT_MODEL_PRESETS} (Kimi K2.7 default + GLM-5.2) on first use,
 * and the default cannot be deleted. The single-default promotion is enforced in the
 * repository.
 */
export class ModelPresetService {
  private readonly presets: ModelPresetRepository
  private readonly workspaceRepository: WorkspaceRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock

  constructor(deps: ModelPresetServiceDependencies) {
    this.presets = deps.modelPresetRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
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
   * Seed the built-in presets for a workspace that has none yet. Idempotent and
   * safe under concurrent first-reads: each seed gets a DETERMINISTIC id
   * (`mdp-seed-<index>`), so two readers racing to seed upsert onto the same rows
   * (ON CONFLICT) rather than creating duplicate built-ins. User-created presets use
   * random ids, so they never collide with these.
   */
  private async ensureSeeded(workspaceId: string): Promise<void> {
    const current = await this.presets.list(workspaceId)
    if (current.length > 0) return
    const now = this.clock.now()
    for (const [i, seed] of DEFAULT_MODEL_PRESETS.entries()) {
      await this.presets.upsert(workspaceId, {
        id: `mdp-seed-${i}`,
        name: seed.name,
        baseModelId: seed.baseModelId,
        overrides: { ...seed.overrides },
        isDefault: seed.isDefault,
        createdAt: now + i,
      })
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
