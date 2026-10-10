import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import {
  personalPasswordCacheKey,
  usePersonalSubscriptionsStore,
} from '~/stores/personalSubscriptions'

// The scoped localStorage key the store caches under, for the stubbed apiBase ('') + user
// (null → 'anon') the default test setup provides (see test/setup.ts). ADR 0026 D7.
const CACHE_KEY = personalPasswordCacheKey('', null)
/** The retired pre-scoping global key. */
const LEGACY_CACHE_KEY = 'cf.personal-pw'
const HOUR = 60 * 60 * 1000
/** Mirrors PASSWORD_EXPIRY_BUFFER_MS in the store — the runway a key must have to be ridden. */
const BUFFER_MS = 8 * HOUR

/** Write a cache entry with an explicit remaining lifetime (positive = valid, negative = past). */
function seedCache(password: string, msFromNow: number, key = CACHE_KEY) {
  localStorage.setItem(key, JSON.stringify({ password, expiresAt: Date.now() + msFromNow }))
}

/** A 428 credential_required error shaped like the server envelope the store parses. */
function credentialError() {
  return new ApiError(428, {
    error: {
      code: 'credential_required',
      message: 'Enter your personal password.',
      details: { vendor: 'claude', reason: 'password_required' },
    },
  })
}

/** Let queued microtasks (the first withCredential attempt + its catch) settle. */
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('personal-password cache expiry buffer', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns a healthy key both plainly and within the buffer', () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('secret', 40 * HOUR)
    expect(store.getCachedPassword()).toBe('secret')
    expect(store.getCachedPassword(BUFFER_MS)).toBe('secret')
  })

  it('withholds a within-buffer key for a buffered read but KEEPS it in storage', () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('secret', 2 * HOUR) // still valid, but under the 8h buffer
    // Plain read still returns it (it has not truly expired)…
    expect(store.getCachedPassword()).toBe('secret')
    // …but a buffered read withholds it so the action re-prompts early.
    expect(store.getCachedPassword(BUFFER_MS)).toBeUndefined()
    // Crucially it is NOT dropped — the key is still valid, just deliberately refreshed early.
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull()
  })

  it('removes a truly-expired key on read', () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('stale', -HOUR)
    expect(store.getCachedPassword()).toBeUndefined()
    expect(localStorage.getItem(CACHE_KEY)).toBeNull()
  })
})

// ADR 0026 D7: the cache is scoped per installation (apiBase) + user, and the retired global
// `cf.personal-pw` key is purged on sight and never reused.
describe('per-installation + per-user cache scoping', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('derives distinct keys per installation and per user', () => {
    // Same origin, different installations (apiBase) → different keys.
    expect(personalPasswordCacheKey('https://a.example', 'usr_1')).not.toBe(
      personalPasswordCacheKey('https://b.example', 'usr_1'),
    )
    // Same installation, different users → different keys.
    expect(personalPasswordCacheKey('https://a.example', 'usr_1')).not.toBe(
      personalPasswordCacheKey('https://a.example', 'usr_2'),
    )
    // A missing user id collapses to a stable `anon` segment (auth disabled).
    expect(personalPasswordCacheKey('https://a.example', null)).toBe(
      personalPasswordCacheKey('https://a.example', undefined),
    )
  })

  it('does NOT read another installation/user cache entry', () => {
    const store = usePersonalSubscriptionsStore()
    // A healthy entry belonging to a DIFFERENT scope must be invisible to this store.
    seedCache('other-secret', 40 * HOUR, personalPasswordCacheKey('https://other', 'usr_x'))
    expect(store.getCachedPassword()).toBeUndefined()
  })

  it('purges the retired global `cf.personal-pw` key on read and never reuses it', () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('legacy-secret', 40 * HOUR, LEGACY_CACHE_KEY)
    // The legacy value is not offered (the scoped key is absent)…
    expect(store.getCachedPassword()).toBeUndefined()
    // …and the retired global key is removed so it can't be reused across installs/users.
    expect(localStorage.getItem(LEGACY_CACHE_KEY)).toBeNull()
  })

  it('round-trips a password under the scoped key', () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('mine', 40 * HOUR)
    expect(store.getCachedPassword()).toBe('mine')
    expect(localStorage.getItem(CACHE_KEY)).not.toBeNull()
  })
})

describe('withCredential early re-entry', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('rides a healthy cached key without prompting', async () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('secret', 40 * HOUR)
    // The action only fails when it receives no password; a healthy key is passed through.
    const action = vi.fn(async (pw?: string) => {
      if (!pw) throw credentialError()
    })
    const ran = await store.withCredential(action)
    expect(ran).toBe(true)
    expect(action).toHaveBeenCalledWith('secret')
    expect(store.pending).toBeNull()
  })

  it('prompts EARLY when the cached key is within the buffer, then refreshes it on re-entry', async () => {
    const store = usePersonalSubscriptionsStore()
    seedCache('secret', 2 * HOUR) // valid but within the 8h buffer → withheld on the first try
    const action = vi.fn(async (pw?: string) => {
      if (!pw) throw credentialError()
    })

    const done = store.withCredential(action)
    await flush()

    // The buffered first attempt sent no password → the server 428'd → the modal opened,
    // even though the key had NOT actually expired yet. That is the early re-entry.
    expect(action).toHaveBeenCalledWith(undefined)
    expect(store.pending).not.toBeNull()
    expect(store.pending?.reason).toBe('password_required')

    const pending = store.pending!
    await pending.retry('fresh-secret')

    await expect(done).resolves.toBe(true)
    expect(action).toHaveBeenLastCalledWith('fresh-secret')
    expect(store.pending).toBeNull()
    // The re-entered password is cached with a full (well beyond the buffer) window.
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY)!) as {
      password: string
      expiresAt: number
    }
    expect(cached.password).toBe('fresh-secret')
    expect(cached.expiresAt - Date.now()).toBeGreaterThan(BUFFER_MS)
  })
})
