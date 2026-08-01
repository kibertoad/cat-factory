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

function makeApp(repositories: PersistenceRegistry | undefined) {
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      repositories,
      config: { auth: { sessionSecret: SECRET } },
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
