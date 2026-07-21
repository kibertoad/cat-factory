import {
  type SealedSecretInventory,
  type SealedSecretRef,
  type SecretCipher,
  SecretDecryptError,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { ServerContainer } from '../http/env.js'
import { sweepKeyDriftAndRaise } from './keyDrift.js'

function ref(over: Partial<SealedSecretRef>): SealedSecretRef {
  return {
    source: 'environment_connection',
    id: 'id',
    workspaceId: 'ws1',
    label: 'aws',
    info: 'cat-factory:environments',
    envelope: 'ok',
    sealedAt: 1,
    ...over,
  }
}

// A cipher that fails to decrypt any envelope ending in `-bad` (key mismatch).
const cipher: SecretCipher = {
  encrypt: async (p) => p,
  decrypt: async (envelope) => {
    if (envelope.endsWith('-bad')) throw new SecretDecryptError('key-mismatch', 'nope')
    return 'plain'
  },
}
const cipherFor = () => cipher

function fakeContainer(refs: SealedSecretRef[]) {
  const inventory: SealedSecretInventory = {
    listSealed: async () => refs,
    drop: async () => ({ dropped: true }),
  }
  const raise =
    vi.fn<(workspaceId: string, input: { type: string; blockId: null; payload: { driftAffected: unknown[] } }) => Promise<void>>(
      async () => {},
    )
  const clearByType = vi.fn(async () => true)
  const listOpenByType = vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, 'n1'])))
  const container = {
    sealedSecretInventory: inventory,
    notifications: { service: { raise, clearByType, listOpenByType } },
  } as unknown as ServerContainer
  return { container, raise, clearByType, listOpenByType }
}

describe('sweepKeyDriftAndRaise', () => {
  it('raises ONE key_drift card per affected workspace with the affected list in the payload', async () => {
    const { container, raise, clearByType } = fakeContainer([
      ref({ id: 'a', workspaceId: 'ws1', envelope: 'x-bad', label: 'aws' }),
      ref({ id: 'b', workspaceId: 'ws1', envelope: 'ok' }), // decrypts — not affected
      ref({ id: 'c', workspaceId: 'ws2', envelope: 'y-bad', source: 'observability_connection' }),
    ])
    const result = await sweepKeyDriftAndRaise(container, cipherFor)
    expect(result).toMatchObject({ raised: 2, affected: 2 })
    expect(clearByType).not.toHaveBeenCalled()
    // ws1 card carries only its own affected credential.
    const ws1Call = raise.mock.calls.find((c) => c[0] === 'ws1')!
    expect(ws1Call[1]).toMatchObject({ type: 'key_drift', blockId: null })
    expect(ws1Call[1].payload.driftAffected).toEqual([
      {
        source: 'environment_connection',
        id: 'a',
        label: 'aws',
        reason: 'key-mismatch',
        sealedAt: 1,
      },
    ])
  })

  it('clears a stale card for a workspace whose secrets now all decrypt', async () => {
    const { container, raise, clearByType } = fakeContainer([
      ref({ id: 'a', workspaceId: 'ws1', envelope: 'ok' }),
    ])
    const result = await sweepKeyDriftAndRaise(container, cipherFor)
    expect(result).toMatchObject({ raised: 0, cleared: 1 })
    expect(raise).not.toHaveBeenCalled()
    expect(clearByType).toHaveBeenCalledWith('ws1', 'key_drift')
  })

  it('is a no-op when no inventory is wired', async () => {
    const container = { notifications: { service: {} } } as unknown as ServerContainer
    expect(await sweepKeyDriftAndRaise(container, cipherFor)).toEqual({
      raised: 0,
      cleared: 0,
      affected: 0,
    })
  })
})
