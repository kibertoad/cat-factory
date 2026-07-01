import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { HmacSigner, type MachinePayload, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { authController } from '../src/modules/auth/AuthController.js'

// The mothership mint endpoint (`POST /auth/machine-token`): a privilege boundary that turns a
// session into an account-scoped machine token. Verify the scope is derived ONLY from what the
// user owns, `requestedAccountIds` may only NARROW it, and the audience pin holds.

const SECRET = 'test-session-secret-0123456789'

function makeSession(over: Record<string, unknown> = {}, secret = SECRET): Promise<string> {
  return new HmacSigner(secret).sign({
    id: 'usr_1',
    login: 'dev',
    name: 'Dev',
    avatarUrl: null,
    email: 'dev@x.test',
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + 60_000,
    ...over,
  })
}

function makeApp(opts: { mothership?: boolean; accounts?: { id: string }[] } = {}) {
  const container = {
    repositories: opts.mothership === false ? undefined : {},
    accountService: {
      listForUser: async () => opts.accounts ?? [{ id: 'acc_1' }, { id: 'acc_2' }],
    },
    config: { auth: { sessionSecret: SECRET, machineTokenTtlMs: 60_000 } },
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
