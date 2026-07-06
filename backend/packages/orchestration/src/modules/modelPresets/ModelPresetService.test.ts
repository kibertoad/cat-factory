import { describe, expect, it } from 'vitest'
import type {
  Clock,
  IdGenerator,
  ModelPreset,
  ModelPresetRepository,
  Workspace,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'
import { ModelPresetService } from './ModelPresetService.js'

// A faithful in-memory model-preset repository: enforces the single-default invariant on
// upsert (promoting a default demotes the prior one), so the service's seeding/reseed logic
// is exercised against the same guarantee the D1/Drizzle repos give it.
class InMemoryModelPresetRepository implements ModelPresetRepository {
  private readonly byWorkspace = new Map<string, ModelPreset[]>()

  async get(workspaceId: string, id: string): Promise<ModelPreset | null> {
    return this.byWorkspace.get(workspaceId)?.find((p) => p.id === id) ?? null
  }

  async list(workspaceId: string): Promise<ModelPreset[]> {
    return [...(this.byWorkspace.get(workspaceId) ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  }

  async getDefault(workspaceId: string): Promise<ModelPreset | null> {
    return this.byWorkspace.get(workspaceId)?.find((p) => p.isDefault) ?? null
  }

  async upsert(workspaceId: string, preset: ModelPreset): Promise<void> {
    const list = this.byWorkspace.get(workspaceId) ?? []
    const next = preset.isDefault ? list.map((p) => ({ ...p, isDefault: false })) : [...list]
    const idx = next.findIndex((p) => p.id === preset.id)
    if (idx >= 0) next[idx] = { ...preset }
    else next.push({ ...preset })
    this.byWorkspace.set(workspaceId, next)
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const list = this.byWorkspace.get(workspaceId)
    if (!list) return
    this.byWorkspace.set(
      workspaceId,
      list.filter((p) => p.id !== id),
    )
  }
}

const workspaceRepository = {
  get: async (id: string): Promise<Workspace> => ({ id, name: 'WS' }) as Workspace,
} as unknown as WorkspaceRepository

function makeService(defaultPresetId?: string): ModelPresetService {
  const clock: Clock = { now: () => 1000 }
  let seq = 0
  const idGenerator: IdGenerator = { next: (prefix = 'id') => `${prefix}_${seq++}` }
  return new ModelPresetService({
    modelPresetRepository: new InMemoryModelPresetRepository(),
    workspaceRepository,
    idGenerator,
    clock,
    ...(defaultPresetId ? { defaultPresetId } : {}),
  })
}

describe('ModelPresetService seeding default resolution', () => {
  it('seeds the catalog with the facade default (Kimi) when no default id is configured', async () => {
    const seeded = await makeService().list('ws1')
    expect(seeded).toHaveLength(3)
    expect(seeded.filter((p) => p.isDefault)).toHaveLength(1)
    expect(seeded.find((p) => p.isDefault)?.id).toBe(MODEL_PRESET_SEED_IDS.kimi)
  })

  it('honours a configured deployment default (local mode → Claude)', async () => {
    const seeded = await makeService(MODEL_PRESET_SEED_IDS.claude).list('ws1')
    expect(seeded.filter((p) => p.isDefault)).toHaveLength(1)
    expect(seeded.find((p) => p.isDefault)?.id).toBe(MODEL_PRESET_SEED_IDS.claude)
  })

  it('falls back to the catalog default when the configured default id is not a built-in', async () => {
    // A deploy-app wrapper passing a stale/mistyped id must never seed a workspace with NO
    // default (which would break the single-default invariant and leave the UI unselected).
    const seeded = await makeService('mdp_does_not_exist').list('ws1')
    expect(seeded).toHaveLength(3)
    const defaults = seeded.filter((p) => p.isDefault)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]?.id).toBe(DEFAULT_MODEL_PRESET_ID)
  })
})
