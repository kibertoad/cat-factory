import { describe, expect, it, vi } from 'vitest'
import type { SecretCipher } from './secret-cipher.js'
import {
  ORG_SECRET_SOURCES,
  createOrgSecretCipher,
  type DelegatedSecretRef,
  type SecretDelegate,
} from './secret-delegation.js'

const localCipher = (): SecretCipher => ({
  encrypt: vi.fn(async (v: string) => `local(${v})`),
  decrypt: vi.fn(async (v: string) => v.replace(/^local\(|\)$/g, '')),
})

const ref: DelegatedSecretRef = {
  source: 'environment_access',
  workspaceId: 'ws-1',
  key: ['env-1'],
}

describe('createOrgSecretCipher', () => {
  it('is a pass-through to the local cipher when no delegate is wired', async () => {
    const cipher = localCipher()
    const org = createOrgSecretCipher({ cipher })

    expect(await org.encryptFor(ref, 'plain')).toBe('local(plain)')
    expect(await org.decryptFor(ref, 'local(plain)')).toBe('plain')
    expect(cipher.encrypt).toHaveBeenCalledWith('plain')
    expect(cipher.decrypt).toHaveBeenCalledWith('local(plain)')
  })

  it('routes BOTH directions to the delegate when one is wired, never the local key', async () => {
    const cipher = localCipher()
    const delegate: SecretDelegate = {
      unseal: vi.fn(async () => 'org-plaintext'),
      seal: vi.fn(async () => 'org(sealed)'),
    }
    const org = createOrgSecretCipher({ cipher, delegate })

    // The seal direction is the load-bearing half: a node that sealed locally would store a row
    // the org can never open, and nothing would say so until a hosted read or a teardown needed it.
    expect(await org.encryptFor(ref, 'plain')).toBe('org(sealed)')
    expect(await org.decryptFor(ref, 'local(anything)')).toBe('org-plaintext')
    expect(cipher.encrypt).not.toHaveBeenCalled()
    expect(cipher.decrypt).not.toHaveBeenCalled()
  })

  it('addresses the delegate by ROW, never by envelope', async () => {
    const unseal = vi.fn(async () => 'org-plaintext')
    const org = createOrgSecretCipher({
      cipher: localCipher(),
      delegate: { unseal, seal: async () => 'x' },
    })

    await org.decryptFor(ref, 'local(secret-ciphertext)')

    expect(unseal).toHaveBeenCalledWith(ref)
    // The whole non-oracle property in one assertion: nothing the delegate received carries the
    // ciphertext, so a mothership can only ever answer for a row it re-reads and scope-checks.
    expect(JSON.stringify(unseal.mock.calls)).not.toContain('secret-ciphertext')
  })

  it('propagates a delegate failure rather than degrading to a local attempt', async () => {
    const cipher = localCipher()
    const org = createOrgSecretCipher({
      cipher,
      delegate: {
        unseal: async () => {
          throw new Error('mothership unreachable')
        },
        seal: async () => {
          throw new Error('mothership unreachable')
        },
      },
    })

    await expect(org.decryptFor(ref, 'local(plain)')).rejects.toThrow('mothership unreachable')
    await expect(org.encryptFor(ref, 'plain')).rejects.toThrow('mothership unreachable')
    expect(cipher.decrypt).not.toHaveBeenCalled()
    expect(cipher.encrypt).not.toHaveBeenCalled()
  })

  it('declares a non-empty, duplicate-free source vocabulary', () => {
    expect(ORG_SECRET_SOURCES.length).toBeGreaterThan(0)
    expect(new Set(ORG_SECRET_SOURCES).size).toBe(ORG_SECRET_SOURCES.length)
  })
})
