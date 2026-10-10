import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { useNotificationsStore } from '~/stores/notifications'
import { useWorkspaceStore } from '~/stores/workspace'

// The notification manager's LOAD outcome, which decides whether the settings panel may offer a
// save at all. Its write is a full replace of the board's overrides, and the grid it saves is
// pre-filled with the shipped defaults, so a load that ended in anything but `ready` must be
// distinguishable: rendering an unknown configuration as the current one turns one press of Save
// into a silent wipe of every override the board had.

describe('notifications store: manager settings load outcome', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('is `ready` with the board matrix once the read succeeds', async () => {
    const settings = { matrix: { merge_review: { email: false } }, updatedAt: 7 }
    vi.stubGlobal('useApi', () => ({
      getNotificationSettings: () => Promise.resolve(settings),
    }))

    const store = useNotificationsStore()
    await store.loadSettings()

    expect(store.settingsStatus).toBe('ready')
    expect(store.settings).toEqual(settings)
  })

  it('is `unavailable` (settled, not an error) when the deployment wired no routing store', async () => {
    vi.stubGlobal('useApi', () => ({
      getNotificationSettings: () =>
        Promise.reject(
          new ApiError(503, { error: { code: 'unavailable', message: 'no routing store' } }),
        ),
    }))

    const store = useNotificationsStore()
    // A 503 is the opt-in shape, so the caller is not asked to report it.
    await expect(store.loadSettings()).resolves.toBeUndefined()

    expect(store.settingsStatus).toBe('unavailable')
    expect(store.settings).toBeNull()
  })

  it('is `failed`, NOT `unavailable`, on a transient read fault, and still surfaces it', async () => {
    vi.stubGlobal('useApi', () => ({
      getNotificationSettings: () =>
        Promise.reject(
          new ApiError(500, { error: { code: 'internal', message: 'upstream exploded' } }),
        ),
    }))

    const store = useNotificationsStore()
    await expect(store.loadSettings()).rejects.toThrow('upstream exploded')

    // The distinction IS the fix: `unavailable` means the shipped defaults are the whole truth,
    // while `failed` means the board's real configuration is unknown and must not be written over.
    expect(store.settingsStatus).toBe('failed')
    expect(store.settings).toBeNull()
  })

  it('leaves no stale matrix behind when a reload fails after a good load', async () => {
    let fail = false
    vi.stubGlobal('useApi', () => ({
      getNotificationSettings: () =>
        fail
          ? Promise.reject(new ApiError(500, { error: { code: 'internal', message: 'gone' } }))
          : Promise.resolve({ matrix: { ci_failed: { in_app: false } }, updatedAt: 1 }),
    }))

    const store = useNotificationsStore()
    await store.loadSettings()
    fail = true
    await expect(store.loadSettings()).rejects.toThrow()

    expect(store.settingsStatus).toBe('failed')
    expect(store.settings).toBeNull()
  })
})
