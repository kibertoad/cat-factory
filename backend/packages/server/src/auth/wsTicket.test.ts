import { describe, expect, it } from 'vitest'
import type { AuthConfig } from '../config/types.js'
import { signerFor, TOKEN_AUDIENCE } from './signing.js'
import { authorizeWsUpgrade, mintWsTicket, type WsTicket } from './wsTicket.js'

// A minimal AuthConfig — `mintWsTicket`/`authorizeWsUpgrade` only read enabled/devOpen/sessionSecret.
function auth(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    enabled: true,
    devOpen: false,
    sessionSecret: 'test-secret-that-is-long-enough-for-hmac',
    ...overrides,
  } as AuthConfig
}

const verify = (secret: string, token: string) =>
  signerFor(secret).verify<WsTicket>(token, { aud: TOKEN_AUDIENCE.wsTicket })

describe('wsTicket', () => {
  it('stamps the minting userId onto the ticket for audit', async () => {
    const cfg = auth()
    const token = await mintWsTicket(cfg, 'ws_a', 'usr_1')
    const decoded = await verify(cfg.sessionSecret, token)
    expect(decoded?.workspaceId).toBe('ws_a')
    expect(decoded?.userId).toBe('usr_1')
  })

  it('omits userId when the minting request had no session', async () => {
    const cfg = auth()
    const token = await mintWsTicket(cfg, 'ws_a')
    const decoded = await verify(cfg.sessionSecret, token)
    expect(decoded?.workspaceId).toBe('ws_a')
    expect(decoded?.userId).toBeUndefined()
  })

  it('returns an empty ticket when auth is disabled (open handshake)', async () => {
    expect(await mintWsTicket(auth({ enabled: false }), 'ws_a', 'usr_1')).toBe('')
  })

  it('verification stays membership-blind: any minting user authorises the matching workspace', async () => {
    const cfg = auth()
    // A ticket minted for one user authorises the handshake for its workspace; the audit
    // `userId` is never consulted on verify — only the workspace + audience + expiry matter.
    const token = await mintWsTicket(cfg, 'ws_a', 'usr_audit')
    expect(await authorizeWsUpgrade(cfg, token, 'ws_a')).toEqual({ ok: true })
    // ...but a ticket for a different workspace is still rejected (workspace binding holds).
    const rejected = await authorizeWsUpgrade(cfg, token, 'ws_other')
    expect(rejected.ok).toBe(false)
  })
})
