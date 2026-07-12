import { describe, expect, it } from 'vitest'
import type {
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
