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
