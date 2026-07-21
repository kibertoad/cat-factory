import type { KeyFingerprintStore } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { checkKeyFingerprint, computeKeyFingerprint } from './keyFingerprint.js'
import { base64url } from './encoding.js'

// A valid 32-byte base64url master key, and a different one.
const KEY_A = base64url(new Uint8Array(32).fill(1))
const KEY_B = base64url(new Uint8Array(32).fill(2))

function fakeStore(initial: string | null = null): KeyFingerprintStore & { value: string | null } {
  const store = {
    value: initial,
    get: async () => store.value,
    set: async (fp: string) => {
      // Seed-once semantics, like the real repos (never clobber).
      if (store.value === null) store.value = fp
    },
  }
  return store
}

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('computeKeyFingerprint', () => {
  it('is deterministic and short (8 bytes → base64url)', async () => {
    const fp = await computeKeyFingerprint(KEY_A)
    expect(fp).toBe(await computeKeyFingerprint(KEY_A))
    // 8 bytes base64url (no padding) → 11 chars.
    expect(fp).toHaveLength(11)
  })

  it('differs for a different key', async () => {
    expect(await computeKeyFingerprint(KEY_A)).not.toBe(await computeKeyFingerprint(KEY_B))
  })

  it('rejects an under-length key', async () => {
    await expect(computeKeyFingerprint(base64url(new Uint8Array(16)))).rejects.toThrow(
      /at least 32 bytes/,
    )
  })
})

describe('checkKeyFingerprint', () => {
  it('seeds the fingerprint on first boot (first-seen)', async () => {
    const store = fakeStore(null)
    const logger = silentLogger()
    const result = await checkKeyFingerprint({ store, masterKeyBase64: KEY_A, logger })
    expect(result.status).toBe('first-seen')
    expect(store.value).toBe(await computeKeyFingerprint(KEY_A))
    expect(logger.info).toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports a match when the key is unchanged', async () => {
    const store = fakeStore(await computeKeyFingerprint(KEY_A))
    const logger = silentLogger()
    const result = await checkKeyFingerprint({ store, masterKeyBase64: KEY_A, logger })
    expect(result.status).toBe('match')
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports drift and does NOT overwrite the stored fingerprint when the key changed', async () => {
    const stored = await computeKeyFingerprint(KEY_A)
    const store = fakeStore(stored)
    const logger = silentLogger()
    const result = await checkKeyFingerprint({ store, masterKeyBase64: KEY_B, logger })
    expect(result).toMatchObject({ status: 'drift', stored })
    expect(store.value).toBe(stored) // never clobbered — the drift signal is preserved
    expect(logger.error).toHaveBeenCalledOnce()
  })
})
