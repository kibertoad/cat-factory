import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type LocalSettingsStore, createLocalSettingsStore } from './localSettingsStore.js'

// Unit coverage for the mothership-mode local-settings store. It asserts the `node:sqlite`
// singleton behaves identically to `DrizzleLocalSettingsRepository` — a missing row reads as
// null (caller uses defaults), and the createdAt-preserving singleton upsert.

describe('SqliteLocalSettingsRepository', () => {
  let store: LocalSettingsStore

  beforeEach(() => {
    store = createLocalSettingsStore(':memory:')
  })
  afterEach(() => store.close())

  it('returns null when nothing is persisted yet', async () => {
    expect(await store.localSettingsRepository.get()).toBeNull()
  })

  it('round-trips the singleton config', async () => {
    const repo = store.localSettingsRepository
    await repo.upsert({ config: '{"poolMinWarm":2}', createdAt: 100, updatedAt: 100 })
    expect(await repo.get()).toEqual({
      config: '{"poolMinWarm":2}',
      createdAt: 100,
      updatedAt: 100,
    })
  })

  it('preserves createdAt and overwrites config + updatedAt on upsert conflict (singleton)', async () => {
    const repo = store.localSettingsRepository
    await repo.upsert({ config: '{"a":1}', createdAt: 100, updatedAt: 100 })
    // A second upsert is the SAME singleton row: createdAt must survive, config + updatedAt change.
    await repo.upsert({ config: '{"a":2}', createdAt: 999, updatedAt: 200 })
    expect(await repo.get()).toEqual({ config: '{"a":2}', createdAt: 100, updatedAt: 200 })
  })
})
