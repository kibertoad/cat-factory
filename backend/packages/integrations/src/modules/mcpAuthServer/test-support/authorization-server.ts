import type { PublicApiKeyRecord, PublicApiKeyRepository, SecretCipher } from '@cat-factory/kernel'
import { PublicApiKeyService } from '../../publicApi/PublicApiKeyService.js'
import { McpAuthorizationServer } from '../McpAuthorizationServer.js'

// The fixture both authorization-server suites drive: one server, one real key store, one host.
//
// Shared rather than duplicated because the two suites assert opposite things about the SAME
// machine (what a host walks away with, and what stops one that should not), so a fixture that
// drifted between them would let a refusal be tested against a server the grant never used.

/** A transparent cipher: these suites assert on what is SEALED, so it must be inspectable. */
export const cipher: SecretCipher = {
  encrypt: async (value) => `sealed(${value})`,
  decrypt: async (value) => {
    const match = /^sealed\((.*)\)$/s.exec(value)
    if (!match) throw new Error('not sealed by this cipher')
    return match[1]!
  },
}

export class MemoryKeyRepository implements PublicApiKeyRepository {
  readonly rows = new Map<string, PublicApiKeyRecord>()
  async add(record: PublicApiKeyRecord) {
    this.rows.set(record.id, record)
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null
  }
  async listByWorkspace(workspaceId: string) {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.revokedAt === null,
    )
  }
  async markUsed(id: string, at: number) {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, lastUsedAt: at })
  }
  async revoke(workspaceId: string, id: string, at: number) {
    const row = this.rows.get(id)
    if (row && row.workspaceId === workspaceId) this.rows.set(id, { ...row, revokedAt: at })
  }
  async revokeMintedBy() {}
}

export const REDIRECT = 'https://host.example/callback'
export const RESOURCE = 'https://cat.example/api/v1/mcp'

/** PKCE, done the way a client does it, so the server's check is exercised rather than mirrored. */
export async function pkce(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * The server under test, over the REAL `PublicApiKeyService` and a memory repository.
 *
 * Real rather than stubbed because the property worth asserting is not "a string came back" but
 * that the string AUTHENTICATES, on the workspace and at the scope a human picked. A stub would
 * agree with any implementation, including one that minted a key on the wrong board.
 */
export function build(now = () => 1_700_000_000_000) {
  const repository = new MemoryKeyRepository()
  const publicApiKeys = new PublicApiKeyService({
    repository,
    pepper: 'pepper-for-tests-only',
    idGenerator: { next: (prefix) => `${prefix}_${repository.rows.size + 1}` },
    clock: { now },
  })
  return {
    repository,
    publicApiKeys,
    server: new McpAuthorizationServer({ secretCipher: cipher, publicApiKeys, clock: { now } }),
  }
}

/** Register, authorize, approve and redeem, as a host and a human between them would. */
export async function connect(
  fixture: ReturnType<typeof build>,
  overrides: { verifier?: string; scope?: 'read' | 'write' | 'decide' | 'admin' } = {},
) {
  const verifier = overrides.verifier ?? 'a-verifier-only-the-host-has'
  const client = await fixture.server.registerClient({
    clientName: 'Test Host',
    redirectUris: [REDIRECT],
  })
  const { sealedRequest } = await fixture.server.beginAuthorization({
    clientId: client.clientId,
    redirectUri: REDIRECT,
    responseType: 'code',
    codeChallenge: await pkce(verifier),
    codeChallengeMethod: 'S256',
    state: 'host-state',
    resource: RESOURCE,
    expectedResource: RESOURCE,
  })
  const request = await fixture.server.readAuthorizationRequest(sealedRequest)
  const { redirectTo } = await fixture.server.approve(request!, {
    accountId: 'acc_1',
    workspaceId: 'ws_1',
    scope: overrides.scope ?? 'write',
    approvedByUserId: 'user_1',
  })
  return { client, request: request!, redirectTo, verifier }
}
