import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppCaches } from '@cat-factory/caching'
import type { ModelPreset, ModelPresetRepository, Workspace } from '@cat-factory/kernel'
import {
  ModelPresetService,
  resolvePresetProviderPreference,
  resolvePresetRouting,
} from './ModelPresetService.js'

// The model-preset row is the merge preset's twin one table over, and it is read HARDER: every
// dispatch resolves it for the step's model AND the preset's route order, every inline call
// resolves it again, and the start guard resolves it once per capability set. So it goes through
// the `modelPreset` AppCaches slice, and EVERY `ModelPresetService` write must drop the workspace
// group — otherwise a re-pointed model or a re-ordered route list keeps dispatching on the stale
// value for the TTL. These drive the REAL cache (`createAppCaches`) the way the run path does.

const WS = 'ws_1'

function fakeRepo(): ModelPresetRepository & { reads: number } {
  const rows = new Map<string, ModelPreset>()
  const repo = {
    reads: 0,
    get: async (_ws: string, id: string) => {
      repo.reads++
      return rows.get(id) ?? null
    },
    getDefault: async () => {
      repo.reads++
      return [...rows.values()].find((p) => p.isDefault) ?? null
    },
    list: async () => [...rows.values()],
    upsert: async (ws: string, preset: ModelPreset) => {
      await repo.upsertMany(ws, [preset])
    },
    upsertMany: async (_ws: string, presets: ModelPreset[]) => {
      // Single-default invariant (matches the real repos): a promoted member demotes every row
      // outside the batch, and each member's own flag stands.
      const ids = new Set(presets.map((p) => p.id))
      if (presets.some((p) => p.isDefault)) {
        for (const [id, p] of rows) if (!ids.has(id)) p.isDefault = false
      }
      for (const preset of presets) rows.set(preset.id, { ...preset })
    },
    remove: async (_ws: string, id: string) => {
      rows.delete(id)
    },
  }
  return repo as unknown as ModelPresetRepository & { reads: number }
}

function makeService(
  repo: ModelPresetRepository,
  modelPresetCache?: ReturnType<typeof createAppCaches>['modelPreset'],
) {
  // Separate counters: a shared one would be bumped by BOTH the id mint and the clock, so the
  // second preset created would be `mdp_3` and the assertions below would name a row that isn't there.
  let ids = 0
  let ticks = 0
  return new ModelPresetService({
    modelPresetRepository: repo,
    workspaceRepository: { get: async () => ({ id: WS }) as Workspace } as never,
    idGenerator: { next: (p: string) => `${p}_${++ids}` } as never,
    clock: { now: () => 1000 + ticks++ } as never,
    modelPresetCache,
  })
}

describe('the model-preset cache slice', () => {
  let caches: ReturnType<typeof createAppCaches>
  beforeEach(() => {
    caches = createAppCaches()
  })

  it('serves a warmed default read from cache, then re-loads after every write', async () => {
    const repo = fakeRepo()
    const service = makeService(repo, caches.modelPreset)
    await service.create(WS, {
      name: 'Compliance',
      baseModelId: 'kimi-k2.7',
      overrides: {},
      isDefault: false,
    })

    const read = () => resolvePresetProviderPreference(repo, WS, undefined, caches.modelPreset)
    await read()
    const afterWarm = repo.reads
    await read()
    expect(repo.reads).toBe(afterWarm) // second read served from the slice

    await service.update(WS, 'mdp_1', { providerPreference: ['bedrock'] })
    expect(await read()).toEqual(['bedrock']) // the write dropped the group
  })

  it('drops the group on remove and on reseed too', async () => {
    const repo = fakeRepo()
    const service = makeService(repo, caches.modelPreset)
    const invalidate = vi.spyOn(caches.modelPreset, 'invalidateGroup')
    await service.create(WS, {
      name: 'A',
      baseModelId: 'kimi-k2.7',
      overrides: {},
      isDefault: false,
    })
    await service.create(WS, {
      name: 'B',
      baseModelId: 'kimi-k2.7',
      overrides: {},
      isDefault: false,
    })
    invalidate.mockClear()
    await service.remove(WS, 'mdp_2')
    expect(invalidate).toHaveBeenCalledWith(WS)
  })

  it('drops the group after the lazy first-use seed', async () => {
    // A dispatch that resolved before seeding cached the null default; without this it would keep
    // resolving on the deployment routing fallback rather than the freshly seeded library.
    const repo = fakeRepo()
    const service = makeService(repo, caches.modelPreset)
    await resolvePresetProviderPreference(repo, WS, undefined, caches.modelPreset) // warms `null`
    const invalidate = vi.spyOn(caches.modelPreset, 'invalidateGroup')
    await service.list(WS)
    expect(invalidate).toHaveBeenCalledWith(WS)
  })

  it('caches a NULL default as a value rather than re-loading it every time', async () => {
    // The wrapper exists because layered-loader treats a bare `null` as unresolved, so an unseeded
    // workspace would otherwise re-query on every single dispatch.
    const repo = fakeRepo()
    await resolvePresetProviderPreference(repo, WS, undefined, caches.modelPreset)
    const afterWarm = repo.reads
    await resolvePresetProviderPreference(repo, WS, undefined, caches.modelPreset)
    expect(repo.reads).toBe(afterWarm)
  })

  it('keys a SELECTED preset separately from the default', async () => {
    const repo = fakeRepo()
    const service = makeService(repo, caches.modelPreset)
    await service.create(WS, {
      name: 'Default',
      baseModelId: 'kimi-k2.7',
      overrides: {},
      isDefault: false,
    })
    await service.create(WS, {
      name: 'Compliance',
      baseModelId: 'kimi-k2.7',
      overrides: {},
      isDefault: false,
    })
    await service.update(WS, 'mdp_2', { providerPreference: ['bedrock'] })

    expect(await resolvePresetProviderPreference(repo, WS, 'mdp_2', caches.modelPreset)).toEqual([
      'bedrock',
    ])
    // The default is a different key, so warming the selected one cannot answer for it.
    expect(
      await resolvePresetProviderPreference(repo, WS, undefined, caches.modelPreset),
    ).toBeUndefined()
  })
})

describe('resolvePresetRouting', () => {
  it('answers the model AND the order from ONE read of the preset row', async () => {
    // Asking the two resolvers separately read the same row twice on every dispatch and every
    // inline call, which is why they arrive together.
    const repo = fakeRepo()
    const service = makeService(repo)
    await service.create(WS, {
      name: 'Compliance',
      baseModelId: 'kimi-k2.7',
      overrides: { coder: 'claude-opus-5' },
      isDefault: false,
      providerPreference: ['bedrock'],
    })
    const before = repo.reads
    const routing = await resolvePresetRouting(repo, WS, 'coder', 'mdp_1')
    // `pinnedForKind` reports that the id came from the preset NAMING `coder`, not from its base
    // model: the two are the same string here and mean different things to a caller carrying a
    // model default of its own.
    expect(routing).toEqual({
      modelId: 'claude-opus-5',
      pinnedForKind: true,
      providerPreference: ['bedrock'],
    })
    expect(repo.reads - before).toBe(1)
  })

  it('omits the order when the preset states none, rather than reporting an empty one', async () => {
    const repo = fakeRepo()
    const service = makeService(repo)
    await service.create(WS, {
      name: 'Plain',
      baseModelId: 'kimi-k2.7',
      overrides: {},
      isDefault: false,
    })
    const routing = await resolvePresetRouting(repo, WS, 'coder', 'mdp_1')
    expect(routing.modelId).toBe('kimi-k2.7')
    expect('providerPreference' in routing).toBe(false)
  })
})
