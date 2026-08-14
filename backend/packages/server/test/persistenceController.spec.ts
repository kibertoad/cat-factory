import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import type { AppEnv } from '../src/http/env.js'
import { persistenceController } from '../src/modules/persistence/PersistenceController.js'
import type { PersistenceRegistry } from '../src/persistence/rpc.js'

/**
 * Controller-level coverage for `POST /internal/persistence`. `persistenceRpc*.spec.ts` drive
 * `dispatchPersistenceCall` directly with hand-built resolvers, so the CONTROLLER's own logic —
 * which resolvers it wires and, in particular, the per-request memo overrides it substitutes into
 * the registry — is only exercised here.
 *
 * The memo overrides are the subject: `memoizeRead` returns a function unconditionally (it closes
 * over an optional-chained call), so substituting one for a repository the deployment does not wire
 * would satisfy the dispatcher's wiring check and answer a misconfiguration with a scope 404 rather
 * than the `... is not wired` that names what to fix.
 */

const SECRET = 'test-session-secret'
const ACCOUNT = 'acc_in'
const OTHER_ACCOUNT = 'acc_out'

/** A skill source under each account, so the `skillSource` scope has something to resolve. */
const SOURCES: Record<string, { id: string; accountId: string }> = {
  sklsrc_in: { id: 'sklsrc_in', accountId: ACCOUNT },
  sklsrc_out: { id: 'sklsrc_out', accountId: OTHER_ACCOUNT },
}

function makeApp(
  repositories: PersistenceRegistry | undefined,
  opts: { revokedNodeIds?: string[]; rosterThrows?: boolean } = {},
) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      repositories,
      config: { auth: { sessionSecret: SECRET } },
      // The machine-node roster the shared gate consults (SEC-5); wired only when the
      // test names revoked nodes, mirroring a facade without the store.
      ...(opts.revokedNodeIds || opts.rosterThrows
        ? {
            machineNodeRepository: {
              isRevoked: async (nodeId: string) => {
                if (opts.rosterThrows) throw new Error('roster down')
                return (opts.revokedNodeIds ?? []).includes(nodeId)
              },
            },
          }
        : {}),
    } as unknown as AppEnv['Variables']['container'])
    await next()
  })
  app.route('/', persistenceController())
  return app
}

async function machineToken(accountIds: string[] = [ACCOUNT]) {
  return signerFor(SECRET).sign({
    aud: TOKEN_AUDIENCE.machine,
    nodeId: 'node_1',
    userId: 'usr_1',
    scope: { accountIds },
    exp: Date.now() + 60_000,
  })
}

async function call(
  app: Hono<AppEnv>,
  repo: string,
  method: string,
  args: unknown[],
  accountIds?: string[],
) {
  const res = await app.request('/internal/persistence', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await machineToken(accountIds)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ repo, method, args }),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('persistence RPC controller: memo overrides never fake a wired repository', () => {
  let getCalls: string[]

  beforeEach(() => {
    getCalls = []
  })

  /** A registry WITH the skills library wired (the mothership has it configured). */
  const withSkills = (): PersistenceRegistry =>
    ({
      skillSourceRepository: {
        get: async (id: string) => {
          getCalls.push(id)
          return SOURCES[id] ?? null
        },
      },
    }) as unknown as PersistenceRegistry

  it('serves skillSourceRepository.get for an in-scope source', async () => {
    const { status, body } = await call(makeApp(withSkills()), 'skillSourceRepository', 'get', [
      'sklsrc_in',
    ])
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, value: { id: 'sklsrc_in', accountId: ACCOUNT } })
  })

  it('shares ONE read between the scope resolver and the dispatched call', async () => {
    // The `skillSource` rule resolves the source's account by reading the source; when the
    // dispatched method IS that read, the memo must serve both — not issue a second query.
    await call(makeApp(withSkills()), 'skillSourceRepository', 'get', ['sklsrc_in'])
    expect(getCalls).toEqual(['sklsrc_in'])
  })

  it('refuses an out-of-scope source as 404 without leaking its existence', async () => {
    const { body } = await call(makeApp(withSkills()), 'skillSourceRepository', 'get', [
      'sklsrc_out',
    ])
    expect(body).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  // The regression. With the library UNWIRED the operator's fix is to enable it on the mothership,
  // so the answer has to say the repository is not wired. Before the override was gated on the real
  // registry, the memo satisfied the wiring check and the scope rule then failed closed on the
  // unresolvable source — reporting a missing ROW where the truth was a missing REPOSITORY.
  it('reports "not wired" — not a scope 404 — when the repository is absent', async () => {
    const { body } = await call(
      makeApp({} as PersistenceRegistry),
      'skillSourceRepository',
      'get',
      ['sklsrc_in'],
    )
    expect(body).toMatchObject({ ok: false, error: { code: 'unknown_method' } })
    expect(String((body.error as { message: string }).message)).toMatch(/is not wired/)
  })

  it('reports "not wired" for the block/service memo overrides too', async () => {
    const app = makeApp({} as PersistenceRegistry)
    const cases: Array<{ repo: string; method: string; args: unknown[] }> = [
      { repo: 'blockRepository', method: 'findById', args: ['blk_1'] },
      { repo: 'blockRepository', method: 'findByIds', args: [['blk_1']] },
      { repo: 'serviceRepository', method: 'get', args: ['svc_1'] },
      { repo: 'serviceRepository', method: 'listByIds', args: [['svc_1']] },
    ]
    for (const { repo, method, args } of cases) {
      const { body } = await call(app, repo, method, args)
      expect(
        String((body.error as { message: string }).message),
        `${repo}.${method} should report the missing repository`,
      ).toMatch(/is not wired/)
    }
  })

  it('still 503s when the facade attaches no registry at all', async () => {
    const { status } = await call(makeApp(undefined), 'skillSourceRepository', 'get', ['sklsrc_in'])
    expect(status).toBe(503)
  })
})

describe('persistence RPC controller: an unreadable source table never reads as an absent row', () => {
  // `fragmentSourceRepository.upsert` binds through `ownerFieldUpsert`, whose STORED half is
  // decided by row EXISTENCE — an id no row holds is a create, admitted on the declared owner
  // alone. That admission is only sound while "no such row" is distinguishable from "this
  // deployment cannot read that table": a facade wiring the write without the read (or a library
  // added to `LibrarySourceEntity` with no resolver row) would otherwise turn every foreign id
  // into a create and hand back the cross-tenant repoint the rule exists to close.
  const upsertBody = (id: string) => [{ id, ownerKind: 'account', ownerId: ACCOUNT }]

  /** The write wired, the read NOT — the half-wired facade the rule must not trust. */
  const writeOnly = () =>
    ({
      fragmentSourceRepository: { upsert: async () => undefined },
    }) as unknown as PersistenceRegistry

  /** Both wired, with one source owned by ANOTHER account. */
  const readable = () =>
    ({
      fragmentSourceRepository: {
        upsert: async () => undefined,
        get: async (id: string) =>
          id === 'fragsrc_out' ? { id, ownerKind: 'account', ownerId: OTHER_ACCOUNT } : null,
      },
    }) as unknown as PersistenceRegistry

  it('refuses the upsert when the source table has no readable `get`', async () => {
    const { body } = await call(
      makeApp(writeOnly()),
      'fragmentSourceRepository',
      'upsert',
      upsertBody('fragsrc_anything'),
    )
    expect(body).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })

  it('still admits a genuine CREATE when the table IS readable', async () => {
    const { status, body } = await call(
      makeApp(readable()),
      'fragmentSourceRepository',
      'upsert',
      upsertBody('fragsrc_new'),
    )
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true })
  })

  it("still refuses an id naming another tenant's existing source", async () => {
    const { body } = await call(
      makeApp(readable()),
      'fragmentSourceRepository',
      'upsert',
      upsertBody('fragsrc_out'),
    )
    expect(body).toMatchObject({ ok: false, error: { code: 'not_found' } })
  })
})

describe('persistence RPC controller: revoked machine nodes (SEC-5)', () => {
  it('refuses a REVOKED node with the same 403 as an invalid token', async () => {
    // The token itself still verifies (valid signature, live exp); the roster tombstone
    // alone is what kills it, which is the whole point of the kill switch.
    const app = makeApp(
      { skillSourceRepository: { get: async () => null } } as unknown as PersistenceRegistry,
      { revokedNodeIds: ['node_1'] },
    )
    const { status, body } = await call(app, 'skillSourceRepository', 'get', ['sklsrc_in'])
    expect(status).toBe(403)
    expect(body).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  })

  it('fails CLOSED when the roster read throws, rather than serving the call', async () => {
    // An unreadable roster is not consent to serve a possibly-revoked node. The gate lets the
    // throw propagate, which `handleError` turns into a 500 the machine client retries; the one
    // thing it must never be is a 200.
    const app = makeApp(
      {
        skillSourceRepository: { get: async () => SOURCES.sklsrc_in },
      } as unknown as PersistenceRegistry,
      { rosterThrows: true },
    )
    // Asserted on the raw response: the throw propagates past the controller's own
    // `{ ok: false }` envelopes to the app's error handler, so the body is not JSON here. The
    // status is the whole point (a retryable 5xx, never a served 200).
    const res = await app.request('/internal/persistence', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await machineToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repository: 'skillSourceRepository',
        method: 'get',
        args: ['sklsrc_in'],
      }),
    })
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it('serves a live node unchanged when the roster is wired', async () => {
    const app = makeApp(
      {
        skillSourceRepository: { get: async (id: string) => SOURCES[id] ?? null },
      } as unknown as PersistenceRegistry,
      { revokedNodeIds: ['node_other'] },
    )
    const { status } = await call(app, 'skillSourceRepository', 'get', ['sklsrc_in'])
    expect(status).toBe(200)
  })
})
