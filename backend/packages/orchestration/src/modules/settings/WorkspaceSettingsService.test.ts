import { createAppCaches } from '@cat-factory/caching'
import { describe, expect, it, vi } from 'vitest'
import type {
  Workspace,
  WorkspaceRepository,
  WorkspaceSettings,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { WorkspaceSettingsService } from './WorkspaceSettingsService.js'

function fakeRepo(stored: Map<string, WorkspaceSettings>): WorkspaceSettingsRepository {
  return {
    async get(id) {
      return stored.get(id) ?? null
    },
    async listByWorkspaceIds(ids) {
      const out = new Map<string, WorkspaceSettings>()
      for (const id of ids) {
        const s = stored.get(id)
        if (s) out.set(id, s)
      }
      return out
    },
    async upsert(id, settings) {
      stored.set(id, settings)
    },
  }
}

function settings(waitingEscalationMinutes: number): WorkspaceSettings {
  return { ...DEFAULT_WORKSPACE_SETTINGS, waitingEscalationMinutes }
}

const workspaceRepository = {} as WorkspaceRepository

/** A workspace repo that resolves every id (so `update`'s existence check passes). */
const presentWorkspaceRepository = {
  async get(id: string) {
    return { id } as Workspace
  },
} as WorkspaceRepository

describe('WorkspaceSettingsService.getMany', () => {
  it('resolves stored rows and fills the built-in default for absent workspaces', async () => {
    const svc = new WorkspaceSettingsService({
      workspaceSettingsRepository: fakeRepo(
        new Map([
          ['ws_a', settings(10)],
          ['ws_b', settings(20)],
        ]),
      ),
      workspaceRepository,
    })

    const map = await svc.getMany(['ws_a', 'ws_b', 'ws_missing'])
    expect(map.get('ws_a')?.waitingEscalationMinutes).toBe(10)
    expect(map.get('ws_b')?.waitingEscalationMinutes).toBe(20)
    // Every requested id is present — the absent one falls back to the default rather than
    // being dropped, so the escalation sweep always has a threshold for every workspace.
    expect(map.get('ws_missing')).toEqual(DEFAULT_WORKSPACE_SETTINGS)
    expect(map.size).toBe(3)
  })

  it('returns an empty map for an empty id list', async () => {
    const svc = new WorkspaceSettingsService({
      workspaceSettingsRepository: fakeRepo(new Map()),
      workspaceRepository,
    })
    expect((await svc.getMany([])).size).toBe(0)
  })
})

describe('WorkspaceSettingsService cache (workspaceSettings slice)', () => {
  it('reads through the cache — a second get does not re-hit the repository', async () => {
    const repo = fakeRepo(new Map([['ws_a', settings(10)]]))
    const getSpy = vi.spyOn(repo, 'get')
    const svc = new WorkspaceSettingsService({
      workspaceSettingsRepository: repo,
      workspaceRepository,
      workspaceSettingsCache: createAppCaches().workspaceSettings,
    })

    expect((await svc.get('ws_a')).waitingEscalationMinutes).toBe(10)
    expect((await svc.get('ws_a')).waitingEscalationMinutes).toBe(10)
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('caches the built-in default (a workspace with no stored row) without re-reading', async () => {
    const repo = fakeRepo(new Map())
    const getSpy = vi.spyOn(repo, 'get')
    const svc = new WorkspaceSettingsService({
      workspaceSettingsRepository: repo,
      workspaceRepository,
      workspaceSettingsCache: createAppCaches().workspaceSettings,
    })

    expect(await svc.get('ws_missing')).toEqual(DEFAULT_WORKSPACE_SETTINGS)
    expect(await svc.get('ws_missing')).toEqual(DEFAULT_WORKSPACE_SETTINGS)
    // The "absent" case caches as a wrapped null value, so the miss isn't re-loaded.
    expect(getSpy).toHaveBeenCalledTimes(1)
  })

  it('update invalidates the cache — the next get reflects the write immediately', async () => {
    const repo = fakeRepo(new Map([['ws_a', settings(10)]]))
    const svc = new WorkspaceSettingsService({
      workspaceSettingsRepository: repo,
      workspaceRepository: presentWorkspaceRepository,
      workspaceSettingsCache: createAppCaches().workspaceSettings,
    })

    // Warm the cache with the pre-write value.
    expect((await svc.get('ws_a')).waitingEscalationMinutes).toBe(10)

    await svc.update('ws_a', { waitingEscalationMinutes: 42 })

    // Without invalidation this would still serve the warmed 10.
    expect((await svc.get('ws_a')).waitingEscalationMinutes).toBe(42)
  })

  it('scopes cache entries per workspace', async () => {
    const repo = fakeRepo(
      new Map([
        ['ws_a', settings(10)],
        ['ws_b', settings(20)],
      ]),
    )
    const svc = new WorkspaceSettingsService({
      workspaceSettingsRepository: repo,
      workspaceRepository: presentWorkspaceRepository,
      workspaceSettingsCache: createAppCaches().workspaceSettings,
    })

    await svc.get('ws_a')
    await svc.get('ws_b')
    await svc.update('ws_a', { waitingEscalationMinutes: 99 })

    // Only ws_a's entry was dropped; ws_b still serves its (unchanged) cached value.
    expect((await svc.get('ws_a')).waitingEscalationMinutes).toBe(99)
    expect((await svc.get('ws_b')).waitingEscalationMinutes).toBe(20)
  })
})

// The workspace's default test-environment provisioning mechanism. The `custom` branch is the
// only one carrying a second field, and the two rules below are what keep that pair coherent —
// a mismatched pair would seed every NEW service frame with a type no handler can resolve.
describe('WorkspaceSettingsService default provisioning', () => {
  function service(stored = new Map<string, WorkspaceSettings>()) {
    return new WorkspaceSettingsService({
      workspaceSettingsRepository: fakeRepo(stored),
      workspaceRepository: presentWorkspaceRepository,
    })
  }

  it('starts unset, so a fresh board still owes a choice', async () => {
    const current = await service().get('ws_a')
    expect(current.defaultProvisionType).toBeNull()
    expect(current.defaultProvisionManifestId).toBeNull()
  })

  it('records a built-in type', async () => {
    const next = await service().update('ws_a', { defaultProvisionType: 'kubernetes' })
    expect(next.defaultProvisionType).toBe('kubernetes')
    expect(next.defaultProvisionManifestId).toBeNull()
  })

  it('records infraless as a real decision rather than treating it as unset', async () => {
    const next = await service().update('ws_a', { defaultProvisionType: 'infraless' })
    expect(next.defaultProvisionType).toBe('infraless')
  })

  it('records a custom type together with its manifest id', async () => {
    const next = await service().update('ws_a', {
      defaultProvisionType: 'custom',
      defaultProvisionManifestId: 'acme-preview',
    })
    expect(next).toMatchObject({
      defaultProvisionType: 'custom',
      defaultProvisionManifestId: 'acme-preview',
    })
  })

  it('refuses a custom default with no manifest id', async () => {
    await expect(service().update('ws_a', { defaultProvisionType: 'custom' })).rejects.toThrow(
      /custom manifest type/i,
    )
  })

  it('clears a stale manifest id when switching away from custom', async () => {
    const stored = new Map<string, WorkspaceSettings>()
    const svc = service(stored)
    await svc.update('ws_a', {
      defaultProvisionType: 'custom',
      defaultProvisionManifestId: 'acme-preview',
    })

    const next = await svc.update('ws_a', { defaultProvisionType: 'kubernetes' })

    // Left in place, the id would silently reappear on switching back to `custom` — and it
    // would be the id of whatever provider the board used to use, not the one shown now.
    expect(next.defaultProvisionManifestId).toBeNull()
    expect(stored.get('ws_a')?.defaultProvisionManifestId).toBeNull()
  })

  it('leaves an existing choice alone when a patch touches something else', async () => {
    const svc = service()
    await svc.update('ws_a', { defaultProvisionType: 'docker-compose' })

    const next = await svc.update('ws_a', { waitingEscalationMinutes: 30 })

    expect(next.defaultProvisionType).toBe('docker-compose')
  })
})

// The custom metadata bag: values for the fields a deployment declares in its app (read by
// external-tool URL resolvers, among others). The two rules below are what make a saved bag
// mean exactly what the editor showed.
describe('WorkspaceSettingsService custom metadata', () => {
  function service(stored = new Map<string, WorkspaceSettings>()) {
    return new WorkspaceSettingsService({
      workspaceSettingsRepository: fakeRepo(stored),
      workspaceRepository: presentWorkspaceRepository,
    })
  }

  it('starts empty, so an unconfigured field reads as absent rather than blank', async () => {
    expect((await service().get('ws_a')).metadata).toEqual({})
  })

  it('replaces the whole bag, so a field the editor cleared is gone', async () => {
    const svc = service()
    await svc.update('ws_a', { metadata: { gameId: 'zork', region: 'eu' } })

    const next = await svc.update('ws_a', { metadata: { gameId: 'zork' } })

    // A merge would keep `region` forever: the editor has no way to say "remove this key"
    // other than by not submitting it.
    expect(next.metadata).toEqual({ gameId: 'zork' })
  })

  it('drops a cleared value instead of storing an empty string', async () => {
    const next = await service().update('ws_a', { metadata: { gameId: '  ', region: ' eu ' } })

    // `gameId` absent (not ''), so a resolver reports the field as missing rather than
    // building a tool URL with an empty game id; the kept value is trimmed.
    expect(next.metadata).toEqual({ region: 'eu' })
  })

  it('leaves the stored bag alone when a patch touches something else', async () => {
    const svc = service()
    await svc.update('ws_a', { metadata: { gameId: 'zork' } })

    const next = await svc.update('ws_a', { waitingEscalationMinutes: 30 })

    expect(next.metadata).toEqual({ gameId: 'zork' })
  })
})
