import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'

// The single localStorage key the store caches the personal password under (private to the
// store; hard-coded here so the buffer/expiry semantics can be asserted directly).
const CACHE_KEY = 'cf.personal-pw'
const HOUR = 60 * 60 * 1000
/** Mirrors PASSWORD_EXPIRY_BUFFER_MS in the store — the runway a key must have to be ridden. */
const BUFFER_MS = 8 * HOUR

/** Write a cache entry with an explicit remaining lifetime (positive = valid, negative = past). */
function seedCache(password: string, msFromNow: number) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ password, expiresAt: Date.now() + msFromNow }))
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
