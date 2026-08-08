import type { NotificationSettingsRecord } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { NotificationSettingsService } from './NotificationSettingsService.js'

// The manager both halves of the feature read: the settings API writes through it and the
// delivery gate asks it. These pin that the two cannot disagree — including on a row the
// service cannot parse, where the honest answer is the shipped default rather than a throw on
// the delivery path.

function service(seed?: NotificationSettingsRecord) {
  const rows = new Map<string, NotificationSettingsRecord>()
  if (seed) rows.set(seed.workspaceId, seed)
  const repo = {
    getByWorkspace: async (workspaceId: string) => rows.get(workspaceId) ?? null,
    upsert: async (record: NotificationSettingsRecord) => {
      rows.set(record.workspaceId, record)
    },
  }
  return {
    rows,
    settings: new NotificationSettingsService({
      notificationSettingsRepository: repo,
      clock: { now: () => 5_000 },
    }),
  }
}

describe('NotificationSettingsService', () => {
  it('reports an unconfigured workspace as an empty matrix, not as an error', async () => {
    const { settings } = service()

    expect(await settings.get('ws-1')).toEqual({ matrix: {}, updatedAt: 0 })
    // …and routing then answers from the shipped defaults.
    expect(await settings.isRouted('ws-1', 'merge_review', 'email')).toBe(true)
    expect(await settings.isRouted('ws-1', 'requirement_review', 'email')).toBe(false)
  })

  it('routes from the saved overrides once a workspace configures them', async () => {
    const { settings } = service()

    const saved = await settings.update('ws-1', {
      merge_review: { email: false },
      requirement_review: { email: true },
    })

    expect(saved.updatedAt).toBe(5_000)
    expect(await settings.isRouted('ws-1', 'merge_review', 'email')).toBe(false)
    expect(await settings.isRouted('ws-1', 'requirement_review', 'email')).toBe(true)
    // A cell the workspace did not touch keeps its default in BOTH directions.
    expect(await settings.isRouted('ws-1', 'merge_review', 'in_app')).toBe(true)
    expect(await settings.isRouted('ws-1', 'ci_failed', 'email')).toBe(true)
  })

  it('resolves a corrupt row to the shipped defaults instead of throwing at the delivery path', async () => {
    const { settings } = service({
      workspaceId: 'ws-1',
      matrixJson: '{ not json at all',
      updatedAt: 1_000,
    })

    expect((await settings.get('ws-1')).matrix).toEqual({})
    expect(await settings.isRouted('ws-1', 'merge_review', 'email')).toBe(true)
  })

  it('keeps the readable overrides of a row written by a build that knew more types', async () => {
    const { settings } = service({
      workspaceId: 'ws-1',
      matrixJson: JSON.stringify({
        ci_failed: { email: false },
        a_type_this_build_retired: { email: false },
      }),
      updatedAt: 1_000,
    })

    expect(await settings.isRouted('ws-1', 'ci_failed', 'email')).toBe(false)
    // One unreadable cell must not unmute everything else the workspace chose.
    expect(Object.keys((await settings.get('ws-1')).matrix)).toEqual(['ci_failed'])
  })
})
