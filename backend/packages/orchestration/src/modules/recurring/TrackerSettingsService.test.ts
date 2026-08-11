import { DEFAULT_TRACKER_WRITEBACK, type TrackerSettings } from '@cat-factory/contracts'
import type { TrackerSettingsRepository, WorkspaceRepository } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { TrackerSettingsService } from './TrackerSettingsService.js'

// The two write shapes this service has, and the difference between them is the whole reason the
// second one exists: `put` REPLACES the row (an omitted flag resets to the deployment default, which
// is what the SPA's panel wants because it has just rendered all three), and `patchWriteback` MERGES
// (which is what `PATCH /api/v1/tracker/writeback` needs, because a caller acting on one decision
// cannot be expected to restate a row it never read).
//
// Both bugs these guard are silent. A merge that let absence become `false` would report exactly what
// the caller asked for while switching off the two actions it never named, and an empty patch that
// still wrote would stamp `updatedAt`, which is the ONLY thing that tells a chosen disposition from
// the defaults nobody has touched.

function store(initial: TrackerSettings | null): {
  repo: TrackerSettingsRepository
  written: TrackerSettings[]
} {
  let row = initial
  const written: TrackerSettings[] = []
  return {
    written,
    repo: {
      get: async () => row,
      put: async (_workspaceId, settings) => {
        row = settings
        written.push(settings)
      },
    },
  }
}

const workspaces = { get: async () => ({ id: 'ws' }) } as unknown as WorkspaceRepository

function serviceOver(initial: TrackerSettings | null) {
  const { repo, written } = store(initial)
  return {
    written,
    service: new TrackerSettingsService({
      trackerSettingsRepository: repo,
      workspaceRepository: workspaces,
      clock: { now: () => 1_700_000_000_000 },
    }),
  }
}

const stored = (overrides: Partial<TrackerSettings> = {}): TrackerSettings => ({
  tracker: 'github',
  jiraProjectKey: null,
  linearTeamId: null,
  writebackCommentOnPrOpen: false,
  writebackResolveOnMerge: false,
  writebackQuestionsOnPark: false,
  updatedAt: 1,
  ...overrides,
})

describe('get', () => {
  it('answers the deployment defaults for a workspace with no row', async () => {
    const { service } = serviceOver(null)
    const settings = await service.get('ws')
    expect(settings).toMatchObject(DEFAULT_TRACKER_WRITEBACK)
    // The sentinel the public projection turns into null: nobody has chosen this.
    expect(settings.updatedAt).toBe(0)
    expect(settings.tracker).toBeNull()
  })
})

describe('put', () => {
  it('resets an omitted flag to the default, because the row is replaced wholesale', async () => {
    const { service } = serviceOver(stored())
    const settings = await service.put('ws', { tracker: 'github' })
    expect(settings.writebackResolveOnMerge).toBe(DEFAULT_TRACKER_WRITEBACK.writebackResolveOnMerge)
  })

  it('keeps a flag the caller set explicitly, including a false', async () => {
    const { service } = serviceOver(null)
    const settings = await service.put('ws', {
      tracker: 'github',
      writebackResolveOnMerge: false,
    })
    expect(settings.writebackResolveOnMerge).toBe(false)
  })
})

describe('patchWriteback', () => {
  it('moves only the flags it names, leaving the others and the filing selection alone', async () => {
    const { service, written } = serviceOver(
      stored({ tracker: 'jira', jiraProjectKey: 'ENG', writebackQuestionsOnPark: true }),
    )
    const settings = await service.patchWriteback('ws', { writebackResolveOnMerge: true })
    expect(settings.writebackResolveOnMerge).toBe(true)
    expect(settings.writebackCommentOnPrOpen).toBe(false)
    expect(settings.writebackQuestionsOnPark).toBe(true)
    expect(settings.tracker).toBe('jira')
    expect(settings.jiraProjectKey).toBe('ENG')
    expect(written).toHaveLength(1)
  })

  it('patches on top of the DEFAULTS when there is no row yet', async () => {
    // The first write has to produce a complete row like any other, and the values it does not name
    // are the deployment defaults rather than false.
    const { service } = serviceOver(null)
    const settings = await service.patchWriteback('ws', { writebackQuestionsOnPark: false })
    expect(settings.writebackQuestionsOnPark).toBe(false)
    expect(settings.writebackResolveOnMerge).toBe(DEFAULT_TRACKER_WRITEBACK.writebackResolveOnMerge)
    expect(settings.updatedAt).toBe(1_700_000_000_000)
  })

  it('does not WRITE for an empty patch, so the defaults cannot be made to look chosen', async () => {
    const { service, written } = serviceOver(null)
    const settings = await service.patchWriteback('ws', {})
    expect(written).toEqual([])
    // Still the sentinel: a no-op that stamped this would claim authorship of the defaults.
    expect(settings.updatedAt).toBe(0)
  })

  it('stamps the write it does make, which is what tells the two states apart', async () => {
    const { service } = serviceOver(null)
    expect(
      (await service.patchWriteback('ws', { writebackCommentOnPrOpen: false })).updatedAt,
    ).toBe(1_700_000_000_000)
  })
})
