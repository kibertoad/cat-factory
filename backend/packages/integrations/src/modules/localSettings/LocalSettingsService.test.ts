import { describe, expect, it } from 'vitest'
import type { LocalSettingsRecord, LocalSettingsRepository } from '@cat-factory/kernel'
import { DEFAULT_LOCAL_SETTINGS } from '@cat-factory/contracts'
import { LocalSettingsService } from './LocalSettingsService.js'

/** An in-memory singleton repo with a call counter (to assert caching). */
function fakeRepo() {
  let row: LocalSettingsRecord | null = null
  let reads = 0
  const repo: LocalSettingsRepository = {
    get: async () => {
      reads++
      return row
    },
    upsert: async (r) => {
      row = r
    },
  }
  return { repo, reads: () => reads }
}

describe('LocalSettingsService', () => {
  it('returns full defaults when no row is persisted', async () => {
    const { repo } = fakeRepo()
    const service = new LocalSettingsService({
      localSettingsRepository: repo,
      clock: { now: () => 0 },
    })
    expect(await service.read()).toEqual(DEFAULT_LOCAL_SETTINGS)
    expect((await service.resolve()).pool.size).toBe(0)
  })

  it('persists a write (full replace) and defaults the partial blob', async () => {
    const { repo } = fakeRepo()
    let t = 1000
    const service = new LocalSettingsService({
      localSettingsRepository: repo,
      clock: { now: () => t },
    })
    const saved = await service.write({
      pool: { size: 3, minWarm: 1, max: null, idleTtlMs: 60_000 },
      checkout: { workspaceRoot: '/ws', cleanKeep: ['node_modules'] },
    })
    expect(saved.pool.size).toBe(3)
    expect(saved.checkout.workspaceRoot).toBe('/ws')
    // The write invalidates the cache, so a fresh read sees the persisted value.
    t = 2000
    expect((await service.resolve()).pool.minWarm).toBe(1)
  })

  it('invokes onChange with the new config after a write (live apply, no restart)', async () => {
    const { repo } = fakeRepo()
    const seen: number[] = []
    const service = new LocalSettingsService({
      localSettingsRepository: repo,
      clock: { now: () => 0 },
      onChange: (s) => {
        seen.push(s.pool.size)
      },
    })
    await service.write({
      pool: { size: 4, minWarm: 2, max: null, idleTtlMs: 60_000 },
      checkout: DEFAULT_LOCAL_SETTINGS.checkout,
    })
    expect(seen).toEqual([4])
  })

  it('does not fail the write when onChange throws (live apply is best-effort)', async () => {
    const { repo } = fakeRepo()
    const service = new LocalSettingsService({
      localSettingsRepository: repo,
      clock: { now: () => 0 },
      onChange: () => {
        throw new Error('transport build still failing')
      },
    })
    await expect(service.write(DEFAULT_LOCAL_SETTINGS)).resolves.toMatchObject({
      pool: { size: 0 },
    })
  })

  it('caches resolve() within the TTL, then reloads after a write', async () => {
    const { repo, reads } = fakeRepo()
    let t = 0
    const service = new LocalSettingsService({
      localSettingsRepository: repo,
      clock: { now: () => t },
    })
    await service.resolve()
    await service.resolve()
    expect(reads()).toBe(1) // second call served from cache
    await service.write(DEFAULT_LOCAL_SETTINGS) // invalidates the cache
    const before = reads()
    await service.resolve()
    expect(reads()).toBe(before + 1) // re-read after invalidation
  })
})
