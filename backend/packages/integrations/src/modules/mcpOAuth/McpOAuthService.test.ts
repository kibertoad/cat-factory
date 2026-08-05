import type {
  McpOAuthConfig,
  McpOAuthGrantRecord,
  McpOAuthGrantRepository,
  SecretCipher,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { McpOAuthService } from './McpOAuthService.js'

// The grant lifecycle, end to end over a fake token endpoint. Four properties carry the weight:
//
//   - a stored access token is REUSED until it is nearly spent, and refreshed rather than handed
//     over once it is (a token that dies mid-run costs the agent a tool the prompt promised it);
//   - a refresh token the server did NOT rotate is carried forward, or a working grant silently
//     becomes single-use;
//   - `invalid_grant` is reported as a failure that is on file, not as "never connected", because
//     the two send an operator to different places;
//   - nothing sealed ever reaches the summary the operator surface renders.

/** A transparent cipher: the tests assert on what is SEALED, so it must be inspectable. */
const cipher: SecretCipher = {
  encrypt: async (value) => `sealed(${value})`,
  decrypt: async (value) => {
    const match = /^sealed\((.*)\)$/s.exec(value)
    if (!match) throw new Error('not sealed by this cipher')
    return match[1]!
  },
}

class MemoryGrantRepository implements McpOAuthGrantRepository {
  readonly rows = new Map<string, McpOAuthGrantRecord>()
  private key(workspaceId: string, serverId: string) {
    return `${workspaceId}|${serverId}`
  }
  async get(workspaceId: string, serverId: string) {
    return this.rows.get(this.key(workspaceId, serverId)) ?? null
  }
  async listByWorkspace(workspaceId: string) {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId)
  }
  async upsert(record: McpOAuthGrantRecord) {
    const existing = this.rows.get(this.key(record.workspaceId, record.serverId))
    this.rows.set(this.key(record.workspaceId, record.serverId), {
      ...record,
      rev: existing ? existing.rev + 1 : record.rev,
    })
  }
  async compareAndSwap(record: McpOAuthGrantRecord, expectedRev: number | null) {
    const existing = this.rows.get(this.key(record.workspaceId, record.serverId))
    if (expectedRev === null) {
      if (existing) return false
      this.rows.set(this.key(record.workspaceId, record.serverId), record)
      return true
    }
    if (!existing || existing.rev !== expectedRev) return false
    this.rows.set(this.key(record.workspaceId, record.serverId), record)
    return true
  }
  async delete(workspaceId: string, serverId: string) {
    this.rows.delete(this.key(workspaceId, serverId))
  }
}

const OAUTH: McpOAuthConfig = {
  grant: 'authorization_code',
  clientId: 'cid',
  authorizationUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  scopes: ['read'],
}

interface TokenCall {
  params: URLSearchParams
}

function harness(
  responses: (call: TokenCall) => { status?: number; body: unknown },
  now = { value: 10_000 },
) {
  const calls: TokenCall[] = []
  const repository = new MemoryGrantRepository()
  const service = new McpOAuthService({
    mcpOAuthGrantRepository: repository,
    secretCipher: cipher,
    clock: { now: () => now.value },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      const call = { params: new URLSearchParams(String(init?.body ?? '')) }
      calls.push(call)
      const { status = 200, body } = responses(call)
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch,
  })
  return { service, repository, calls, now }
}

/** Seed a stored grant by driving a real authorization, so the sealed shape is the real one. */
async function connect(
  h: ReturnType<typeof harness>,
  workspaceId = 'ws1',
  serverId = 'linear',
): Promise<void> {
  const { url } = await h.service.startAuthorization({
    workspaceId,
    serverId,
    serverUrl: 'https://mcp.example.com/mcp',
    oauth: OAUTH,
    userId: 'usr_1',
    redirectUri: 'https://app.example.com/mcp/oauth/callback',
  })
  const state = new URL(url).searchParams.get('state')!
  const request = (await h.service.readAuthorizationRequest(state))!
  await h.service.completeAuthorization(request, { code: 'code-1', clientId: 'cid' })
}

describe('McpOAuthService.startAuthorization', () => {
  it('builds a PKCE authorization url whose state opens only here', async () => {
    const h = harness(() => ({ body: {} }))
    const { url } = await h.service.startAuthorization({
      workspaceId: 'ws1',
      serverId: 'linear',
      serverUrl: 'https://mcp.example.com/mcp',
      oauth: OAUTH,
      userId: 'usr_1',
      redirectUri: 'https://app.example.com/mcp/oauth/callback',
    })
    const params = new URL(url).searchParams
    expect(url.startsWith('https://auth.example.com/authorize?')).toBe(true)
    expect(params.get('response_type')).toBe('code')
    expect(params.get('client_id')).toBe('cid')
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_challenge')).toBeTruthy()
    expect(params.get('scope')).toBe('read')
    // RFC 8707: without it a token minted for this server is replayable against every other server
    // behind the same authorization server.
    expect(params.get('resource')).toBe('https://mcp.example.com/mcp')

    const request = await h.service.readAuthorizationRequest(params.get('state'))
    expect(request).toMatchObject({ workspaceId: 'ws1', serverId: 'linear', userId: 'usr_1' })
    // PKCE's verifier never travels in the clear: only its S256 challenge goes to the vendor, and
    // the verifier itself rides the state through the CIPHER (this harness's cipher is transparent
    // by design, so what is asserted is that the verifier reaches the wire nowhere else).
    expect(params.get('code_verifier')).toBeNull()
    expect(params.get('code_challenge')).not.toBe(request!.codeVerifier)
  })

  it('refuses a state that is forged, expired or not an authorization request', async () => {
    const h = harness(() => ({ body: {} }))
    expect(await h.service.readAuthorizationRequest(null)).toBeNull()
    expect(await h.service.readAuthorizationRequest('not-sealed')).toBeNull()
    expect(
      await h.service.readAuthorizationRequest(
        await cipher.encrypt(JSON.stringify({ kind: 'tokens' })),
      ),
    ).toBeNull()
    const expired = await cipher.encrypt(
      JSON.stringify({ kind: 'authorization-request', exp: 1, workspaceId: 'ws1' }),
    )
    expect(await h.service.readAuthorizationRequest(expired)).toBeNull()
  })

  it('refuses to start an interactive grant for a client-credentials declaration', async () => {
    const h = harness(() => ({ body: {} }))
    await expect(
      h.service.startAuthorization({
        workspaceId: 'ws1',
        serverId: 'internal',
        serverUrl: 'https://mcp.example.com/mcp',
        oauth: { ...OAUTH, grant: 'client_credentials' } satisfies McpOAuthConfig,
        userId: 'usr_1',
        redirectUri: 'https://app.example.com/mcp/oauth/callback',
      }),
    ).rejects.toMatchObject({ details: { reason: 'oauth_grant_not_interactive' } })
  })
})

describe('McpOAuthService.accessToken', () => {
  it('seals the token set and reports a non-secret summary', async () => {
    const h = harness(() => ({
      body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'read write' },
    }))
    await connect(h)

    const row = await h.repository.get('ws1', 'linear')
    expect(row!.summary).not.toContain('at-1')
    expect(row!.summary).not.toContain('rt-1')
    expect(JSON.parse(row!.summary)).toMatchObject({
      connectedBy: 'usr_1',
      connectedAt: 10_000,
      scopes: ['read', 'write'],
      refreshable: true,
    })

    const statuses = await h.service.listStatuses('ws1')
    expect(statuses.get('linear')).toMatchObject({ refreshable: true, scopes: ['read', 'write'] })
  })

  it('reuses a live token and never asks the token endpoint again', async () => {
    const h = harness(() => ({
      body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 },
    }))
    await connect(h)
    const before = h.calls.length

    const result = await h.service.accessToken({
      workspaceId: 'ws1',
      serverId: 'linear',
      serverUrl: 'https://mcp.example.com/mcp',
      oauth: OAUTH,
    })
    expect(result).toEqual({ status: 'ok', header: 'Authorization', value: 'Bearer at-1' })
    expect(h.calls.length).toBe(before)
  })

  it('refreshes a spent token and carries a non-rotated refresh token forward', async () => {
    const h = harness((call) =>
      call.params.get('grant_type') === 'refresh_token'
        ? { body: { access_token: 'at-2', expires_in: 3600 } }
        : { body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 60 } },
    )
    await connect(h)
    h.now.value = 10_000 + 30_000 // inside the expiry skew, so the stored token is spent

    const result = await h.service.accessToken({
      workspaceId: 'ws1',
      serverId: 'linear',
      serverUrl: 'https://mcp.example.com/mcp',
      oauth: OAUTH,
    })
    expect(result).toEqual({ status: 'ok', header: 'Authorization', value: 'Bearer at-2' })
    expect(h.calls.at(-1)!.params.get('refresh_token')).toBe('rt-1')
    // The server rotated nothing, so the grant must stay refreshable rather than become single-use.
    const stored = JSON.parse(
      await cipher.decrypt((await h.repository.get('ws1', 'linear'))!.tokens),
    )
    expect(stored).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1' })
  })

  it('reports a revoked grant as token_failed and records it on the summary', async () => {
    const h = harness((call) =>
      call.params.get('grant_type') === 'refresh_token'
        ? { status: 400, body: { error: 'invalid_grant', error_description: 'revoked' } }
        : { body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 60 } },
    )
    await connect(h)
    h.now.value = 10_000 + 120_000

    const result = await h.service.accessToken({
      workspaceId: 'ws1',
      serverId: 'linear',
      serverUrl: 'https://mcp.example.com/mcp',
      oauth: OAUTH,
    })
    expect(result.status).toBe('token_failed')
    // Still CONNECTED and no longer working: the pair is what stops a dead grant reading as a
    // clean one on the operator surface.
    const status = (await h.service.listStatuses('ws1')).get('linear')
    expect(status?.lastError).toContain('invalid_grant')
    expect(await h.repository.get('ws1', 'linear')).not.toBeNull()
  })

  it('answers not_connected when nothing was ever granted', async () => {
    const h = harness(() => ({ body: {} }))
    expect(
      await h.service.accessToken({
        workspaceId: 'ws1',
        serverId: 'linear',
        serverUrl: 'https://mcp.example.com/mcp',
        oauth: OAUTH,
      }),
    ).toEqual({ status: 'not_connected' })
  })

  it('mints a client-credentials token with no grant on file', async () => {
    const h = harness(() => ({ body: { access_token: 'machine-1', expires_in: 3600 } }))
    const oauth: McpOAuthConfig = { ...OAUTH, grant: 'client_credentials' }
    const result = await h.service.accessToken({
      workspaceId: 'ws1',
      serverId: 'internal',
      serverUrl: 'https://mcp.example.com/mcp',
      oauth,
      clientSecret: 'shh',
    })
    expect(result).toEqual({ status: 'ok', header: 'Authorization', value: 'Bearer machine-1' })
    expect(h.calls.at(-1)!.params.get('grant_type')).toBe('client_credentials')
    expect(h.calls.at(-1)!.params.get('client_secret')).toBe('shh')
    // Cached, so the next dispatch spends no round trip.
    expect(await h.repository.get('ws1', 'internal')).not.toBeNull()
  })

  it('disconnects, after which the next dispatch is not_connected again', async () => {
    const h = harness(() => ({ body: { access_token: 'at-1', refresh_token: 'rt-1' } }))
    await connect(h)
    await h.service.disconnect('ws1', 'linear')
    expect(
      await h.service.accessToken({
        workspaceId: 'ws1',
        serverId: 'linear',
        serverUrl: 'https://mcp.example.com/mcp',
        oauth: OAUTH,
      }),
    ).toEqual({ status: 'not_connected' })
  })

  it('reports a row sealed under a different key as a broken connection, not an absent one', async () => {
    const h = harness(() => ({ body: {} }))
    h.repository.rows.set('ws1|linear', {
      workspaceId: 'ws1',
      serverId: 'linear',
      tokens: 'sealed-by-someone-else',
      summary: '{}',
      rev: 0,
      createdAt: 1,
      updatedAt: 1,
    })
    const result = await h.service.accessToken({
      workspaceId: 'ws1',
      serverId: 'linear',
      serverUrl: 'https://mcp.example.com/mcp',
      oauth: OAUTH,
    })
    expect(result).toMatchObject({ status: 'token_failed' })
  })
})
