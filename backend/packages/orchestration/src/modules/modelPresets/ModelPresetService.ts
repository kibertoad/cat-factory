import type {
  Clock,
  CreateModelPresetInput,
  GroupCacheHandle,
  IdGenerator,
  ModelFlavor,
  ModelPreset,
  ModelPresetCacheValue,
  ModelPresetRepository,
  UpdateModelPresetInput,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  DEFAULT_MODEL_PRESET_ID,
  modelForKindFromPreset,
  presetOverrideForKind,
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
  /**
   * Optional: the `AppCaches.modelPreset` slice the run path resolves a block's preset through
   * (its model for the kind AND its route order). Every write below invalidates the workspace
   * group so a preset edit is visible on the very next dispatch. Absent → the run path reads live
   * (tests / no cache wired).
   */
  modelPresetCache?: GroupCacheHandle<ModelPresetCacheValue>
}

/**
 * CRUD for a workspace's model presets (the library a task picks its model→agent
 * mapping from). A preset is one `baseModelId` applied to every agent kind plus
 * per-kind `overrides`. Maintains the invariant that a workspace always has at least
 * one preset, exactly one of which is the default: {@link list} lazily seeds the
 * built-in catalog ({@link seedModelPresets}: Kimi K2.7, GLM-5.2, Claude Opus 5) on
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
  private readonly cache?: GroupCacheHandle<ModelPresetCacheValue>

  constructor(deps: ModelPresetServiceDependencies) {
    this.presets = deps.modelPresetRepository
    this.workspaceRepository = deps.workspaceRepository
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.cache = deps.modelPresetCache
    // Resolve the deployment's seeded-default id to a REAL catalog id up front. Only a
    // built-in can be seeded as the first-seed default, so a `defaultPresetId` that matches no
    // catalog seed (a stale/mistyped value from a deploy-app wrapper) is a misconfiguration:
    // fall back to the catalog default (Kimi) rather than letting `ensureSeeded` seed a fresh
    // workspace with NO default at all (which would break the single-default invariant and
    // leave the settings UI with nothing selected).
    const requested = deps.defaultPresetId ?? DEFAULT_MODEL_PRESET_ID
    this.defaultPresetId = seedModelPresets().some((p) => p.id === requested)
      ? requested
      : DEFAULT_MODEL_PRESET_ID
  }

  /**
   * Drop the workspace's cached preset library after a write commits. Coarse (one group == one
   * workspace) because a write can flip which preset is the default, so a single edit's blast
   * radius is the whole library — over-invalidation is always safe (CLAUDE.md caching rule).
   */
  private async invalidate(workspaceId: string): Promise<void> {
    await this.cache?.invalidateGroup(workspaceId)
  }

  /**
   * The route order the preset in force states, for a caller that holds the service rather than
   * the repository (the `/models` catalog). Side-effect-free and never seeds, like the free
   * function it delegates to — see {@link resolvePresetProviderPreference}.
   */
  providerPreferenceFor(
    workspaceId: string,
    modelPresetId?: string,
  ): Promise<readonly ModelFlavor[] | undefined> {
    return resolvePresetProviderPreference(this.presets, workspaceId, modelPresetId, this.cache)
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
      // An empty list is the same statement as no list — "use the default order" — so it is
      // normalised away here rather than persisted as an order over no routes.
      ...(input.providerPreference?.length ? { providerPreference: input.providerPreference } : {}),
      createdAt: this.clock.now(),
    }
    await this.presets.upsert(workspaceId, preset)
    await this.invalidate(workspaceId)
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
      // Three distinct patches, and the empty one is the reason this is not a plain spread: an
      // ABSENT `providerPreference` leaves the stored order alone, a non-empty one replaces it,
      // and an EMPTY one resets the preset to the default order (so "reset" needs no route of
      // its own). `undefined` is written, not omitted, so the reset actually clears the column.
      ...(patch.providerPreference !== undefined
        ? {
            providerPreference: patch.providerPreference.length
              ? patch.providerPreference
              : undefined,
          }
        : {}),
    }
    await this.presets.upsert(workspaceId, updated)
    await this.invalidate(workspaceId)
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
    await this.invalidate(workspaceId)
  }

  /**
   * Restore a built-in preset to its current catalog definition ({@link seedModelPresets}).
   * Used to adopt an improved built-in, repair one whose persisted copy drifted, or
   * materialise a NEW built-in that appeared after this workspace was seeded (so it has the
   * old presets but not the new one). The canonical base model / overrides / `version`
   * overwrite (or create) the stored row; an existing copy's `isDefault` + `createdAt` are
   * preserved so reseeding never silently changes which preset is the default or its ordering.
   * A built-in declares no route preference, so a reseed also RESETS one the workspace had set on
   * it — the same disposition as its base model and overrides, which is what "restore the canonical
   * definition" means (a workspace wanting to keep a route order copies the preset instead).
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
    await this.invalidate(workspaceId)
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
    // A dispatch that resolved before first-use seeding cached the null default; drop it so the
    // very next one sees the seeded library rather than the deployment's routing fallback.
    await this.invalidate(workspaceId)
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
  cache?: GroupCacheHandle<ModelPresetCacheValue>,
): Promise<string> {
  return (await resolvePresetRouting(repo, workspaceId, agentKind, modelPresetId, cache)).modelId
}

/**
 * The route order the preset in force states, or undefined for the deployment's default order.
 * The `providerPreference` sibling of {@link resolvePresetModelForKind}: same preset selection
 * (selected id else the workspace default), same side-effect-free contract, so the hot dispatch
 * path and the start guard resolve the order from the same row the model id came from.
 *
 * Undefined covers three facts that need no distinguishing, because all three mean "nothing
 * reorders the routes": the preset states no preference, the library is not yet seeded, and the
 * selected id no longer exists.
 */
export async function resolvePresetProviderPreference(
  repo: ModelPresetRepository,
  workspaceId: string,
  modelPresetId?: string,
  cache?: GroupCacheHandle<ModelPresetCacheValue>,
): Promise<readonly ModelFlavor[] | undefined> {
  return preferenceOf(await presetInForce(repo, workspaceId, modelPresetId, cache))
}

/** Both preset-derived facts a resolution needs, from ONE row. */
export interface PresetRouting {
  /** The model id `agentKind` resolves to (`overrides[kind] ?? baseModelId`). */
  modelId: string
  /**
   * Whether the preset NAMED this agent kind, rather than answering with its base model. A
   * caller carrying a model default of its own (a judge registration's pin) needs the two apart:
   * an override is a statement about this kind and outranks such a default, a base model is a
   * blanket one and does not.
   */
  pinnedForKind: boolean
  /** The preset's route order; undefined ⇒ the deployment's default order. */
  providerPreference?: readonly ModelFlavor[]
}

/**
 * The model a kind runs AND the order that model's routes are tried in, resolved from a SINGLE
 * read of the preset in force.
 *
 * The two facts live in one row and every caller on the run path wants both, so asking for them
 * separately ({@link resolvePresetModelForKind} then {@link resolvePresetProviderPreference}) reads
 * that row twice per resolution. Those two remain for the callers that genuinely want one half —
 * the facade-wired `resolveWorkspaceModelDefault` closure, whose signature the executors share, and
 * the `/models` catalog, which resolves no kind — and both are now folds over this.
 */
export async function resolvePresetRouting(
  repo: ModelPresetRepository,
  workspaceId: string,
  agentKind: string,
  modelPresetId?: string,
  cache?: GroupCacheHandle<ModelPresetCacheValue>,
): Promise<PresetRouting> {
  const preset = await presetInForce(repo, workspaceId, modelPresetId, cache)
  const preference = preferenceOf(preset)
  return {
    modelId: modelForKindFromPreset(preset, agentKind),
    pinnedForKind: presetOverrideForKind(preset, agentKind) !== undefined,
    ...(preference ? { providerPreference: preference } : {}),
  }
}

/** An empty stored order is the same statement as none: "walk the deployment's default". */
function preferenceOf(preset: ModelPreset | null): readonly ModelFlavor[] | undefined {
  const preference = preset?.providerPreference
  return preference?.length ? preference : undefined
}

/**
 * The preset a block resolves under: its selected one, else the workspace default.
 *
 * Read through the `AppCaches.modelPreset` slice when one is wired, keyed per resolved id so a
 * selected preset and the default cache separately, grouped by workspace so one write drops the
 * whole library. A null (deleted selected id / unseeded default) caches as a VALUE and still falls
 * through, exactly as an uncached read would — the `ModelPresetCacheValue` wrapper, since
 * layered-loader treats a bare null as unresolved. The shape is `RunMergePolicy.resolve`'s, one
 * row over.
 */
async function presetInForce(
  repo: ModelPresetRepository,
  workspaceId: string,
  modelPresetId?: string,
  cache?: GroupCacheHandle<ModelPresetCacheValue>,
): Promise<ModelPreset | null> {
  const read = async (
    key: string,
    load: () => Promise<ModelPreset | null>,
  ): Promise<ModelPreset | null> => {
    if (!cache) return load()
    return (await cache.get(key, workspaceId, async () => ({ preset: await load() }))).preset
  }
  if (modelPresetId) {
    const picked = await read(`picked:${modelPresetId}`, () => repo.get(workspaceId, modelPresetId))
    if (picked) return picked
  }
  return read('default', () => repo.getDefault(workspaceId))
}
