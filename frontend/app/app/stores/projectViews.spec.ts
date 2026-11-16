import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectViewsStore } from '~/stores/projectViews'
import { useWorkspaceStore } from '~/stores/workspace'

describe('project views store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('keeps each project view under its own id', async () => {
    vi.stubGlobal('useApi', () => ({
      getProjectBoardView: (_ws: string, projectId: string) =>
        Promise.resolve({ projectId, kind: 'notes', outcomes: [], view: null }),
    }))
    const store = useProjectViewsStore()
    await store.load('prj_a')
    await store.load('prj_b')
    expect(Object.keys(store.views).sort()).toEqual(['prj_a', 'prj_b'])
    expect(store.loading.prj_a).toBe(false)
  })

  it('names the project tier with its project and the board tier without one', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('useApi', () => ({
      setOutcomeStoragePolicy: set,
      getOutcomeStoragePolicy: () => Promise.resolve({ account: null, workspace: null }),
    }))
    const store = useProjectViewsStore()
    await store.setPolicy('prj_a', 'project', { offload: 'disabled' })
    await store.setPolicy('prj_a', 'workspace', null)
    expect(set.mock.calls.map((call) => call[1])).toEqual([
      { tier: 'project', projectId: 'prj_a', policy: { offload: 'disabled' } },
      { tier: 'workspace', policy: null },
    ])
  })
})
