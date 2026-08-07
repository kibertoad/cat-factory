import type { MachineNodeMint, MachineNodeRecord, MachineNodeRepository } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { HmacSigner, type MachinePayload, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { authController } from '../src/modules/auth/AuthController.js'

// The mothership mint endpoint (`POST /auth/machine-token`): a privilege boundary that turns a
// session into an account-scoped machine token. Verify the scope is derived ONLY from what the
// user owns, `requestedAccountIds` may only NARROW it, and the audience pin holds. The roster
// endpoints beside it (SEC-5) are covered below: every mint is recorded, a revoked or foreign
// node id can't be re-minted, and revocation is owner-scoped.

const SECRET = 'test-session-secret-0123456789'

/** An in-memory machine-node roster with the port's exact fold/tombstone semantics. */
function fakeMachineNodes(): MachineNodeRepository & { rows: Map<string, MachineNodeRecord> } {
  const rows = new Map<string, MachineNodeRecord>()
  return {
    rows,
    recordMint: async (m: MachineNodeMint) => {
      const prior = rows.get(m.nodeId)
      // Ownership and the tombstone are enforced by the WRITE in both real repos (a guarded
      // `ON CONFLICT ... WHERE`), so the fake refuses exactly where they do.
      if (prior && (prior.userId !== m.userId || prior.revokedAt !== null)) return 'refused'
      rows.set(m.nodeId, {
        nodeId: m.nodeId,
        userId: prior?.userId ?? m.userId,
        accountIds: m.accountIds,
        createdAt: prior?.createdAt ?? m.mintedAt,
        lastMintedAt: m.mintedAt,
        expiresAt: Math.max(prior?.expiresAt ?? 0, m.expiresAt),
        revokedAt: prior?.revokedAt ?? null,
        revokedByUserId: prior?.revokedByUserId ?? null,
      })
      return 'recorded'
    },
    get: async (nodeId) => rows.get(nodeId) ?? null,
    listByUser: async (userId) =>
      [...rows.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => b.lastMintedAt - a.lastMintedAt),
    revoke: async (nodeId, revokedAt, revokedByUserId) => {
      const row = rows.get(nodeId)
      if (!row) return false
      if (row.revokedAt === null) rows.set(nodeId, { ...row, revokedAt, revokedByUserId })
      return true
    },
    isRevoked: async (nodeId) => rows.get(nodeId)?.revokedAt != null,
    deleteExpired: async () => 0,
  }
}

function makeSession(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  return new HmacSigner(secret).sign({
    id: 'usr_1',
    login: 'dev',
    name: 'Dev',
    avatarUrl: null,
    email: 'dev@x.test',
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 60_000,
    // The session generation the bearer is valid under; the fake store answers 0 for every user.
    gen: 0,
    ...over,
  })
}

function makeApp(
  opts: {
    mothership?: boolean
    accounts?: { id: string }[]
    machineNodes?: MachineNodeRepository
    /** Wire NO roster, to assert a mothership refuses to mint an unrecordable token. */
    noRoster?: boolean
  } = {},
) {
  // A correctly-wired mothership always has a roster: a token it never recorded could never be
  // revoked, so the mint refuses without one. Tests that want that refusal pass `noRoster`.
  const machineNodes = opts.noRoster ? undefined : (opts.machineNodes ?? fakeMachineNodes())
  const container = {
    repositories: opts.mothership === false ? undefined : {},
    accountService: {
      listForUser: async () => opts.accounts ?? [{ id: 'acc_1' }, { id: 'acc_2' }],
    },
    config: { auth: { sessionSecret: SECRET, machineTokenTtlMs: 60_000 } },
    // `verifySession` checks the bearer's generation against the user row on every request.
    userService: { sessionGeneration: async () => 0, refreshSessionGeneration: async () => 0 },
    ...(machineNodes ? { machineNodeRepository: machineNodes } : {}),
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/auth', authController())
  app.onError(handleError)
  return app
}

function mint(app: Hono<AppEnv>, token: string | undefined, body: unknown = {}) {
  return app.fetch(
    new Request('http://x/auth/machine-token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  )
}

describe('POST /auth/machine-token', () => {
  it('mints a token scoped to the user accounts for a valid session', async () => {
    const res = await mint(makeApp(), await makeSession())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; accountIds: string[]; userId: string }
    expect(body.accountIds).toEqual(['acc_1', 'acc_2'])
    expect(body.userId).toBe('usr_1')
    const payload = await new HmacSigner(SECRET).verify<MachinePayload>(body.token, {
      aud: TOKEN_AUDIENCE.machine,
    })
    expect(payload!.scope.accountIds).toEqual(['acc_1', 'acc_2'])
  })

  it('narrows the scope to requestedAccountIds (intersection only)', async () => {
    const res = await mint(makeApp(), await makeSession(), { requestedAccountIds: ['acc_2'] })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { accountIds: string[] }).accountIds).toEqual(['acc_2'])
  })

  it('drops a requested account the user does not own; all-out-of-scope is 403', async () => {
    // A requested id the user does not own is filtered out, never granted.
    const res = await mint(makeApp(), await makeSession(), {
      requestedAccountIds: ['acc_1', 'acc_evil'],
    })
    expect(((await res.json()) as { accountIds: string[] }).accountIds).toEqual(['acc_1'])
    // Requesting ONLY accounts the user doesn't own leaves an empty scope → refused.
    const refused = await mint(makeApp(), await makeSession(), {
      requestedAccountIds: ['acc_evil'],
    })
    expect(refused.status).toBe(403)
  })

  it('refuses when the user owns no accounts', async () => {
    const res = await mint(makeApp({ accounts: [] }), await makeSession())
    expect(res.status).toBe(403)
  })

  it('rejects a missing session (403)', async () => {
    expect((await mint(makeApp(), undefined)).status).toBe(403)
  })

  it('rejects a non-session audience token (403)', async () => {
    // A token minted for another audience cannot be replayed to mint a machine token.
    const containerToken = await makeSession({ aud: TOKEN_AUDIENCE.container })
    expect((await mint(makeApp(), containerToken)).status).toBe(403)
  })

  it('rejects a session signed with a different secret (403)', async () => {
    const foreign = await makeSession({}, 'a-different-secret-9876543210')
    expect((await mint(makeApp(), foreign)).status).toBe(403)
  })

  it('503s on a facade that is not a mothership', async () => {
    expect((await mint(makeApp({ mothership: false }), await makeSession())).status).toBe(503)
  })
})

describe('machine-node roster (SEC-5)', () => {
  it('records every mint against the minting user', async () => {
    const nodes = fakeMachineNodes()
    const res = await mint(makeApp({ machineNodes: nodes }), await makeSession())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nodeId: string; exp: number }
    const row = nodes.rows.get(body.nodeId)
    expect(row).toMatchObject({
      userId: 'usr_1',
      accountIds: ['acc_1', 'acc_2'],
      expiresAt: body.exp,
      revokedAt: null,
    })
  })

  it('refuses re-minting a REVOKED node id (revocation is permanent per node id)', async () => {
    const nodes = fakeMachineNodes()
    const app = makeApp({ machineNodes: nodes })
    const first = (await (await mint(app, await makeSession())).json()) as { nodeId: string }
    await nodes.revoke(first.nodeId, Date.now(), 'usr_1')

    const again = await mint(app, await makeSession(), { nodeId: first.nodeId })
    expect(again.status).toBe(403)
    // A fresh (unnamed) mint still works: reconnecting is the remedy.
    expect((await mint(app, await makeSession())).status).toBe(200)
  })

  it("refuses taking over another user's node id", async () => {
    const nodes = fakeMachineNodes()
    const app = makeApp({ machineNodes: nodes })
    const theirs = (await (await mint(app, await makeSession())).json()) as { nodeId: string }

    const res = await mint(app, await makeSession({ id: 'usr_2' }), { nodeId: theirs.nodeId })
    expect(res.status).toBe(403)
    // The roster still names the original owner.
    expect(nodes.rows.get(theirs.nodeId)?.userId).toBe('usr_1')
  })

  it('refuses to mint at all when a mothership has no roster wired', async () => {
    // An unrecorded machine token is an unrevocable one, so "no roster" must not degrade to
    // minting without a kill switch. 503, because it is the DEPLOYMENT that is misconfigured.
    const res = await mint(makeApp({ noRoster: true }), await makeSession())
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; details?: { reason?: string } } }
    expect(body.error.code).toBe('unavailable')
    expect(body.error.details?.reason).toBe('machine_roster_unavailable')
  })

  it('refuses when the ROSTER WRITE rejects, not merely when a prior read saw the row', async () => {
    // The refusal has to come from the guarded write: a check-then-write left a window where two
    // first mints of one node id both read "unknown" and the loser overwrote the winner's scope.
    // A roster that only ever refuses at write time still produces the 403.
    const nodes = fakeMachineNodes()
    const app = makeApp({
      machineNodes: { ...nodes, get: async () => null, recordMint: async () => 'refused' },
    })
    const res = await mint(app, await makeSession(), { nodeId: 'node_contended' })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { details?: { reason?: string } } }
    expect(body.error.details?.reason).toBe('machine_node_unavailable')
  })

  it('lists only the session user’s nodes', async () => {
    const nodes = fakeMachineNodes()
    const app = makeApp({ machineNodes: nodes })
    await mint(app, await makeSession())
    await mint(app, await makeSession({ id: 'usr_2', login: 'other' }))

    const res = await app.fetch(
      new Request('http://x/auth/machine-nodes', {
        headers: { authorization: `Bearer ${await makeSession()}` },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nodes: { nodeId: string; revokedAt: number | null }[] }
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0]!.revokedAt).toBeNull()
  })

  it('revokes an owned node (204, idempotent) and 404s an unknown or foreign one', async () => {
    const nodes = fakeMachineNodes()
    const app = makeApp({ machineNodes: nodes })
    const minted = (await (await mint(app, await makeSession())).json()) as { nodeId: string }

    const revoke = (nodeId: string, session: Promise<string>) =>
      session.then((token) =>
        app.fetch(
          new Request(`http://x/auth/machine-nodes/${nodeId}/revoke`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      )

    // Another user cannot revoke it, and learns nothing (404, not 403).
    expect((await revoke(minted.nodeId, makeSession({ id: 'usr_2' }))).status).toBe(404)
    expect(await nodes.isRevoked(minted.nodeId)).toBe(false)

    expect((await revoke(minted.nodeId, makeSession())).status).toBe(204)
    expect(await nodes.isRevoked(minted.nodeId)).toBe(true)
    // Idempotent: revoking again still 204s and keeps the tombstone.
    expect((await revoke(minted.nodeId, makeSession())).status).toBe(204)

    expect((await revoke('node_unknown', makeSession())).status).toBe(404)
  })

  it('503s the roster endpoints when no roster store is wired', async () => {
    const app = makeApp({ noRoster: true })
    const res = await app.fetch(
      new Request('http://x/auth/machine-nodes', {
        headers: { authorization: `Bearer ${await makeSession()}` },
      }),
    )
    expect(res.status).toBe(503)
  })
})
