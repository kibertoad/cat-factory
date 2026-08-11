import { describe, expect, it } from 'vitest'
import { DEFAULT_TRACKER_WRITEBACK, type TrackerSettings } from '@cat-factory/contracts'
import { toPublicWriteback, toWritebackPatch } from './PublicTrackerController.js'

// The two mappers, for the same reason `PublicProvisioningController.test.ts` tests its two: every
// other property of this controller is guarded structurally (the scope floor fails OpenAPI
// generation when absent, the surface table fails SDK generation without an entry, and the delegate
// is the app's own service method), and these are the two places a wrong answer still looks right.
//
// Both bugs they guard are silent in the same direction. A patch that turned absence into `false`
// would report exactly what the caller asked for while switching off the two actions it never named,
// and a projection that let `updatedAt: 0` through would tell a caller somebody configured this in
// 1970.

const settings = (overrides: Partial<TrackerSettings> = {}): TrackerSettings => ({
  tracker: 'github',
  jiraProjectKey: null,
  linearTeamId: null,
  ...DEFAULT_TRACKER_WRITEBACK,
  updatedAt: 1_700_000_000_000,
  ...overrides,
})

describe('toWritebackPatch', () => {
  it('carries ONLY the actions the caller named', () => {
    // The whole point of the route being a PATCH: the service merges what it is given onto the
    // stored row, so a key present here is a key written. One naming `resolveOnMerge` must not
    // arrive carrying the other two.
    expect(toWritebackPatch({ writeback: { resolveOnMerge: true } })).toEqual({
      writebackResolveOnMerge: true,
    })
  })

  it('carries a FALSE, which is a decision and not an absence', () => {
    expect(toWritebackPatch({ writeback: { questionsOnPark: false } })).toEqual({
      writebackQuestionsOnPark: false,
    })
  })

  it('is empty for a patch that names nothing, so the service can no-op without writing', () => {
    // An empty write would stamp `updatedAt`, which is how a reader tells a chosen disposition from
    // the deployment defaults. Both spellings of "nothing" reach here.
    expect(toWritebackPatch({})).toEqual({})
    expect(toWritebackPatch({ writeback: {} })).toEqual({})
  })

  it('spells every action the way the settings row does', () => {
    // The rename is the mapping's whole job (`commentOnPrOpen` on the wire,
    // `writebackCommentOnPrOpen` in the row), and a typo in one key would silently leave that
    // action unchanged on every call.
    expect(
      toWritebackPatch({
        writeback: { commentOnPrOpen: true, resolveOnMerge: false, questionsOnPark: true },
      }),
    ).toEqual({
      writebackCommentOnPrOpen: true,
      writebackResolveOnMerge: false,
      writebackQuestionsOnPark: true,
    })
  })
})

describe('toPublicWriteback', () => {
  it('publishes the three actions under the names the surface uses', () => {
    const view = toPublicWriteback(
      settings({
        writebackCommentOnPrOpen: true,
        writebackResolveOnMerge: false,
        writebackQuestionsOnPark: true,
      }),
    )
    expect(view.writeback).toEqual({
      commentOnPrOpen: true,
      resolveOnMerge: false,
      questionsOnPark: true,
    })
    expect(view.updatedAt).toBe(1_700_000_000_000)
  })

  it('reports "nobody has chosen this" as NULL rather than as an epoch timestamp', () => {
    // `updatedAt: 0` is the settings service's sentinel for an absent row. Passed through as a
    // number it is a value a caller formats and compares, and every one of those readings is wrong.
    expect(toPublicWriteback(settings({ updatedAt: 0 })).updatedAt).toBeNull()
  })

  it('publishes the deployment defaults for a workspace that has configured nothing', () => {
    // Asserted against the shared constant, not against `true`: this is the same value the writeback
    // service and the SPA's panel resolve, and the point of the constant is that a change of stance
    // moves all three together.
    const view = toPublicWriteback(settings({ updatedAt: 0 }))
    expect(view.writeback).toEqual({
      commentOnPrOpen: DEFAULT_TRACKER_WRITEBACK.writebackCommentOnPrOpen,
      resolveOnMerge: DEFAULT_TRACKER_WRITEBACK.writebackResolveOnMerge,
      questionsOnPark: DEFAULT_TRACKER_WRITEBACK.writebackQuestionsOnPark,
    })
  })

  it('publishes nothing about the filing selection the row also holds', () => {
    // The projection is the seam that keeps the frozen surface off an internal shape: `tracker`,
    // `jiraProjectKey` and `linearTeamId` are a different decision with its own rules, and a spread
    // here would publish all three by accident and owe them forever.
    const view = toPublicWriteback(settings({ tracker: 'jira', jiraProjectKey: 'ENG' }))
    expect(Object.keys(view).sort()).toEqual(['updatedAt', 'writeback'])
  })
})
