import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCapabilityCredentialsStore } from '~/stores/capabilityCredentials'
import { useWorkspaceStore } from '~/stores/workspace'
import type { CapabilityCredentialsView } from '~/types/capabilityCredentials'

/**
 * Two behaviours carry this store, and both are about a list that is empty for more than one
 * reason:
 *
 *   - the probe. A 503 ("no encryption key on this deployment") and a 403 ("you may not manage
 *     secrets") are ANSWERS and resolve normally, hiding the tab; anything else propagates,
 *     because the panel is the surface that can tell a reader the list could not be fetched.
 *   - `hasSurface`. An empty checklist with a COMPLETE declaration read means this deployment
 *     registers no capability that wants a credential, so there is nothing to type; the same
 *     empty checklist with an INCOMPLETE read is an outage the panel has to state.
 */
function view(over: Partial<CapabilityCredentialsView> = {}): CapabilityCredentialsView {
  return {
    declared: [],
    orphaned: [],
    environmentFallback: true,
    declarationsIncomplete: false,
    ...over,
  }
}

function declared(key: string, stored = false) {
  return {
    key,
    declaredBy: [{ subject: 'tool-server' as const, id: 'srv', label: 'Search' }],
    required: true,
    stored,
    ...(stored ? { updatedAt: 1000 } : {}),
  }
}

describe('capabilityCredentials store', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('load stores the view and marks the surface available', async () => {
    vi.stubGlobal('useApi', () => ({
      getCapabilityCredentials: () => Promise.resolve(view({ declared: [declared('SEARCH_KEY')] })),
    }))

    const store = useCapabilityCredentialsStore()
    await store.load()

    expect(store.available).toBe(true)
    expect(store.hasSurface).toBe(true)
    expect(store.loading).toBe(false)
  })

  it.each([503, 403])(
    'a definitive %i latches the surface unavailable without throwing',
    async (statusCode) => {
      // 503: the deployment has no encryption key. 403: this caller may not manage secrets, and
      // the READ is gated too, because the view names the credential keys the deployment wants.
      // Both hide the tab rather than disabling it.
      vi.stubGlobal('useApi', () => ({
        getCapabilityCredentials: () => Promise.reject({ statusCode }),
      }))

      const store = useCapabilityCredentialsStore()
      await expect(store.load()).resolves.toBeUndefined()

      expect(store.available).toBe(false)
      expect(store.view).toBeNull()
      expect(store.hasSurface).toBe(false)
    },
  )

  it('a transient failure propagates and leaves `available` null so the probe stays retryable', async () => {
    vi.stubGlobal('useApi', () => ({
      getCapabilityCredentials: () => Promise.reject({ statusCode: 500 }),
    }))

    const store = useCapabilityCredentialsStore()
    await expect(store.load()).rejects.toMatchObject({ statusCode: 500 })

    expect(store.available).toBeNull()
    expect(store.loading).toBe(false)
  })

  it('offers no surface when nothing is declared and nothing is stored', async () => {
    vi.stubGlobal('useApi', () => ({ getCapabilityCredentials: () => Promise.resolve(view()) }))

    const store = useCapabilityCredentialsStore()
    await store.load()

    // The panel is a checklist projected from the deployment's registered capabilities. With
    // none, there is no credential to type and the tab would be a dead end.
    expect(store.available).toBe(true)
    expect(store.hasSurface).toBe(false)
  })

  it('keeps the surface when the declaration read failed, even with both lists empty', async () => {
    vi.stubGlobal('useApi', () => ({
      getCapabilityCredentials: () => Promise.resolve(view({ declarationsIncomplete: true })),
    }))

    const store = useCapabilityCredentialsStore()
    await store.load()

    // An unreadable list and an empty one are the same list and opposite facts. Hiding the tab
    // here would render someone else's outage as "this deployment needs no credentials".
    expect(store.hasSurface).toBe(true)
  })

  it('keeps the surface for an orphan nothing declares any more', async () => {
    vi.stubGlobal('useApi', () => ({
      getCapabilityCredentials: () =>
        Promise.resolve(view({ orphaned: [{ key: 'OLD_KEY', updatedAt: 1000 }] })),
    }))

    const store = useCapabilityCredentialsStore()
    await store.load()

    // A live secret nobody will ever ask for. The tab is the only place it can be removed.
    expect(store.hasSurface).toBe(true)
  })

  it('saves ONE key and adopts the returned view', async () => {
    const calls: { key: string; value: string }[] = []
    vi.stubGlobal('useApi', () => ({
      getCapabilityCredentials: () => Promise.resolve(view({ declared: [declared('SEARCH_KEY')] })),
      setCapabilityCredential: (_ws: string, key: string, value: string) => {
        calls.push({ key, value })
        return Promise.resolve(view({ declared: [declared('SEARCH_KEY', true)] }))
      },
    }))

    const store = useCapabilityCredentialsStore()
    await store.load()
    await store.save('SEARCH_KEY', 'sk-live')

    // Per KEY, never a set-replacing write: this client never received the other values, so a
    // whole-set save would delete every credential the operator did not retype.
    expect(calls).toEqual([{ key: 'SEARCH_KEY', value: 'sk-live' }])
    expect(store.view?.declared[0]?.stored).toBe(true)
  })

  it('re-reads after a delete rather than patching the row out locally', async () => {
    let stored = true
    vi.stubGlobal('useApi', () => ({
      getCapabilityCredentials: () =>
        Promise.resolve(view({ declared: [declared('SEARCH_KEY', stored)] })),
      deleteCapabilityCredential: () => {
        stored = false
        return Promise.resolve(undefined)
      },
    }))

    const store = useCapabilityCredentialsStore()
    await store.load()
    await store.remove('SEARCH_KEY')

    // The DELETE answers 204, and the declared half is deployment state this client does not
    // own: a locally-patched row would drift from it the moment the deployment changed.
    expect(store.view?.declared[0]?.stored).toBe(false)
  })
})
