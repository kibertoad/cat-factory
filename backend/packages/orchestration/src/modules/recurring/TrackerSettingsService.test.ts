import { DEFAULT_TRACKER_WRITEBACK, type TrackerSettings } from '@cat-factory/contracts'
import type {
  TrackerSettingsPatch,
  TrackerSettingsRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { TrackerSettingsService } from './TrackerSettingsService.js'

// The two write shapes this service has, and the ONE rule they share: a field the caller did not
// name is not written. `put` owns the FILING selection and replaces it wholesale; `patchWriteback`
// owns the writeback half and is what `PATCH /api/v1/tracker/writeback` calls. Neither fills an
// omitted writeback action in from the deployment defaults.
//
// Every bug these guard is silent. A merge that let absence become `false` would report exactly what
// the caller asked for while switching off the two actions it never named; absence becoming the
// DEFAULT is the same bug pointed the other way, and it is the one that shipped: the
// recurring-pipeline dialog persists a filing tracker, names no action, and so re-enabled writeback
// on every workspace that had turned it off. An empty patch that still wrote would stamp
// `updatedAt`, which is the ONLY thing that tells a chosen disposition from the defaults nobody has
// touched.
//
// The fake below mirrors what the two real repositories do in SQL, which is the point of moving the
// merge down there: it writes the named columns onto the stored row and seeds an absent one from
// the defaults it is handed. `written` records the PATCHES, so a test can assert what was NAMED
// rather than what the merged row happens to hold.

function store(initial: TrackerSettings | null): {
  repo: TrackerSettingsRepository
  written: TrackerSettingsPatch[]
} {
  let row = initial
  const written: TrackerSettingsPatch[] = []
  return {
    written,
    repo: {
      get: async () => row,
      merge: async (_workspaceId, patch, defaults, updatedAt) => {
        written.push(patch)
        row = { ...(row ?? defaults), ...patch, updatedAt }
        return row
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
  it('never NAMES a writeback action the caller omitted, so a stored off stays off', async () => {
    // The regression that shipped: the recurring-pipeline dialog sends the filing selection alone.
    // Asserted on the patch rather than on the answer, because a service that named all three would
    // return this same row on a workspace whose stored values happened to match.
    const { service, written } = serviceOver(stored())
    const settings = await service.put('ws', { tracker: 'github' })
    expect(written).toEqual([{ tracker: 'github', jiraProjectKey: null, linearTeamId: null }])
    expect(settings.writebackResolveOnMerge).toBe(false)
  })

  it('keeps a flag the caller set explicitly, including a false', async () => {
    const { service } = serviceOver(null)
    const settings = await service.put('ws', {
      tracker: 'github',
      writebackResolveOnMerge: false,
    })
    expect(settings.writebackResolveOnMerge).toBe(false)
  })

  it('seeds an absent row from the defaults for the actions nobody has ever chosen', async () => {
    const { service } = serviceOver(null)
    const settings = await service.put('ws', { tracker: 'github' })
    expect(settings).toMatchObject(DEFAULT_TRACKER_WRITEBACK)
  })

  it('replaces the filing selection wholesale, clearing the other vendor’s target', async () => {
    const { service } = serviceOver(stored({ tracker: 'jira', jiraProjectKey: 'ENG' }))
    const settings = await service.put('ws', { tracker: 'linear', linearTeamId: 'team_1' })
    expect(settings.jiraProjectKey).toBeNull()
    expect(settings.linearTeamId).toBe('team_1')
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
    // ONE field named, so the store is what decides the other five, not this process.
    expect(written).toEqual([{ writebackResolveOnMerge: true }])
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
