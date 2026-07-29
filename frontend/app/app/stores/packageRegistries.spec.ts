import { describe, it, expect, beforeEach, vi } from 'vitest'
import { usePackageRegistriesStore } from '~/stores/packageRegistries'
import { useWorkspaceStore } from '~/stores/workspace'
import type { PackageRegistryEntryView } from '~/types/packageRegistries'

/**
 * The availability probe and the list read share one `load()`, but their failure contracts are
 * opposite, and the split is what these cases pin:
 *
 *   - a 503 is an ANSWER ("this deployment has no registries module") and resolves normally, so
 *     the Infrastructure window simply shows no tab;
 *   - anything else is a FAILURE that propagates, because the panel — which only renders once
 *     the probe already succeeded — is the surface that can tell a reader the list they are
 *     looking at could not be fetched.
 */
function entry(over: Partial<PackageRegistryEntryView> = {}): PackageRegistryEntryView {
  return {
    id: 'pkgreg_1',
    ecosystem: 'npm',
    vendor: 'npmjs',
    scopes: ['@acme'],
    tokenTail: 'cdef',
    ...over,
  }
}

describe('packageRegistries store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('load stores the entries and marks the module available', async () => {
    vi.stubGlobal('useApi', () => ({
      listPackageRegistries: () => Promise.resolve({ entries: [entry()] }),
    }))

    const store = usePackageRegistriesStore()
    await store.load()

    expect(store.available).toBe(true)
    expect(store.entries).toHaveLength(1)
    expect(store.loading).toBe(false)
  })

  it('a definitive 503 latches the module unavailable without throwing', async () => {
    vi.stubGlobal('useApi', () => ({
      listPackageRegistries: () => Promise.reject({ statusCode: 503 }),
    }))

    const store = usePackageRegistriesStore()
    await expect(store.load()).resolves.toBeUndefined()

    expect(store.available).toBe(false)
    expect(store.entries).toEqual([])
  })

  it('a transient failure propagates and leaves `available` null so the probe stays retryable', async () => {
    vi.stubGlobal('useApi', () => ({
      listPackageRegistries: () => Promise.reject({ statusCode: 500 }),
    }))

    const store = usePackageRegistriesStore()
    await expect(store.load()).rejects.toMatchObject({ statusCode: 500 })

    // Never cached as a false "unavailable": a reachable-but-flaky backend must not hide a tab
    // the deployment really has.
    expect(store.available).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('keeps an already-loaded list when a later refresh fails', async () => {
    let fail = false
    vi.stubGlobal('useApi', () => ({
      listPackageRegistries: () =>
        fail ? Promise.reject({ statusCode: 500 }) : Promise.resolve({ entries: [entry()] }),
    }))

    const store = usePackageRegistriesStore()
    await store.load()
    fail = true
    await expect(store.load()).rejects.toMatchObject({ statusCode: 500 })

    // The panel reports the failure; it must not also blank the list the reader had.
    expect(store.available).toBe(true)
    expect(store.entries).toHaveLength(1)
  })

  it('ensureLoaded probes once and stays retryable after a transient failure', async () => {
    let calls = 0
    let fail = true
    vi.stubGlobal('useApi', () => ({
      listPackageRegistries: () => {
        calls += 1
        return fail ? Promise.reject({ statusCode: 500 }) : Promise.resolve({ entries: [] })
      },
    }))

    const store = usePackageRegistriesStore()
    await expect(store.ensureLoaded()).rejects.toMatchObject({ statusCode: 500 })
    expect(calls).toBe(1)

    fail = false
    await store.ensureLoaded()
    expect(calls).toBe(2)
    expect(store.available).toBe(true)

    // Settled now, so a third caller costs no request.
    await store.ensureLoaded()
    expect(calls).toBe(2)
  })
})
