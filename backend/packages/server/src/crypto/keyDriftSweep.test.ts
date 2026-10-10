import {
  type SealedSecretInventory,
  type SealedSecretRef,
  type SecretCipher,
  SecretDecryptError,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { hasKeyDrift, sweepKeyDrift } from './keyDriftSweep.js'

function ref(id: string, over: Partial<SealedSecretRef> = {}): SealedSecretRef {
  return {
    source: 'environment_connection',
    id,
    workspaceId: 'ws1',
    label: 'aws',
    info: 'cat-factory:environments',
    envelope: `env-${id}`,
    sealedAt: 1000,
    ...over,
  }
}

/** A cipher whose decrypt outcome is decided by the envelope's suffix. */
const cipher: SecretCipher = {
  encrypt: async (p) => p,
  decrypt: async (envelope) => {
    if (envelope.endsWith('-mismatch')) throw new SecretDecryptError('key-mismatch', 'nope')
    if (envelope.endsWith('-corrupt')) throw new SecretDecryptError('corrupt', 'bad envelope')
    if (envelope.endsWith('-boom')) throw new Error('unexpected')
    return 'plain'
  },
}

function inventoryOf(refs: SealedSecretRef[]): SealedSecretInventory {
  return {
    listSealed: async () => refs,
    drop: async () => ({ dropped: true }),
  }
}

describe('sweepKeyDrift', () => {
  it('buckets each secret by decrypt outcome', async () => {
    const report = await sweepKeyDrift({
      inventory: inventoryOf([
        ref('a', { envelope: 'ok' }),
        ref('b', { envelope: 'x-mismatch' }),
        ref('c', { envelope: 'x-corrupt' }),
      ]),
      cipherFor: () => cipher,
    })
    expect(report.ok.map((r) => r.id)).toEqual(['a'])
    expect(report.keyMismatch.map((r) => r.id)).toEqual(['b'])
    expect(report.corrupt.map((r) => r.id)).toEqual(['c'])
    expect(hasKeyDrift(report)).toBe(true)
  })

  it('treats an unexpected (non-typed) decrypt error as corruption and keeps scanning', async () => {
    const report = await sweepKeyDrift({
      inventory: inventoryOf([ref('a', { envelope: 'x-boom' }), ref('b', { envelope: 'ok' })]),
      cipherFor: () => cipher,
    })
    expect(report.corrupt.map((r) => r.id)).toEqual(['a'])
    expect(report.ok.map((r) => r.id)).toEqual(['b'])
  })

  it('reports no drift when everything decrypts', async () => {
    const report = await sweepKeyDrift({
      inventory: inventoryOf([ref('a', { envelope: 'ok' }), ref('b', { envelope: 'ok' })]),
      cipherFor: () => cipher,
    })
    expect(hasKeyDrift(report)).toBe(false)
    expect(report.ok).toHaveLength(2)
  })

  it('builds one cipher per info tag (memoised)', async () => {
    let builds = 0
    await sweepKeyDrift({
      inventory: inventoryOf([
        ref('a', { info: 'cat-factory:environments', envelope: 'ok' }),
        ref('b', { info: 'cat-factory:environments', envelope: 'ok' }),
        ref('c', { info: 'cat-factory:observability', envelope: 'ok' }),
      ]),
      cipherFor: () => {
        builds++
        return cipher
      },
    })
    expect(builds).toBe(2) // one per distinct info tag, not per ref
  })
})
