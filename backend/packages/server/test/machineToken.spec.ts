import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MACHINE_TOKEN_TTL_MS,
  mintMachineToken,
  resolveMachineTokenTtlMs,
} from '../src/index.js'
import { HmacSigner, type MachinePayload, TOKEN_AUDIENCE } from '../src/auth/signing.js'

// The single production mint for the mothership machine token. Its claim shape is the contract
// `PersistenceController` verifies, so pin it down: audience, scope, expiry, and audience-pinned
// verification (a token minted here must NOT verify as any other audience).

const SECRET = 'test-session-secret-0123456789'

describe('mintMachineToken', () => {
  it('mints a token that verifies under the machine audience with the given scope', async () => {
    const token = await mintMachineToken(SECRET, {
      userId: 'usr_1',
      accountIds: ['acc_1', 'acc_2'],
      nodeId: 'node_1',
    })
    const payload = await new HmacSigner(SECRET).verify<MachinePayload>(token, {
      aud: TOKEN_AUDIENCE.machine,
    })
    expect(payload).toMatchObject({
      aud: TOKEN_AUDIENCE.machine,
      userId: 'usr_1',
      nodeId: 'node_1',
      scope: { accountIds: ['acc_1', 'acc_2'] },
    })
    expect(payload!.exp).toBeGreaterThan(Date.now())
  })

  it('does NOT verify under a different audience (cross-token-confusion defence)', async () => {
    const token = await mintMachineToken(SECRET, { userId: 'usr_1', accountIds: ['acc_1'] })
    expect(await new HmacSigner(SECRET).verify(token, { aud: TOKEN_AUDIENCE.session })).toBeNull()
  })

  it('honours an explicit ttl and generates a node id when none is given', async () => {
    const token = await mintMachineToken(SECRET, {
      userId: 'usr_1',
      accountIds: ['acc_1'],
      ttlMs: 1000,
    })
    const payload = await new HmacSigner(SECRET).verify<MachinePayload>(token, {
      aud: TOKEN_AUDIENCE.machine,
    })
    expect(payload!.exp).toBeLessThanOrEqual(Date.now() + 1000)
    expect(payload!.nodeId).toMatch(/^node_/)
  })
})

describe('resolveMachineTokenTtlMs', () => {
  it('takes a positive numeric override, else the default', () => {
    expect(resolveMachineTokenTtlMs('60000')).toBe(60000)
    expect(resolveMachineTokenTtlMs(undefined)).toBe(DEFAULT_MACHINE_TOKEN_TTL_MS)
    expect(resolveMachineTokenTtlMs('')).toBe(DEFAULT_MACHINE_TOKEN_TTL_MS)
    expect(resolveMachineTokenTtlMs('0')).toBe(DEFAULT_MACHINE_TOKEN_TTL_MS)
    expect(resolveMachineTokenTtlMs('-5')).toBe(DEFAULT_MACHINE_TOKEN_TTL_MS)
    expect(resolveMachineTokenTtlMs('abc')).toBe(DEFAULT_MACHINE_TOKEN_TTL_MS)
  })
})
