import {
  createAccountContract,
  listAccountsContract,
  updateAccountContract,
} from '@cat-factory/contracts'
import { requestByContract } from '@toad-contracts/hono'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { accountController } from '../src/modules/accounts/AccountController.js'

// Exercises the contract → buildHonoRoute → validation → response loop at runtime with
// a faked container + signed-in user, the pilot proof that the @toad-contracts/hono
// adapter wires the accounts routes correctly (path, request validation, status/body).

const ACCOUNT = {
  id: 'acc_1',
  type: 'org' as const,
  name: 'Acme',
  githubAccountLogin: null,
  createdAt: 0,
  roles: ['admin' as const],
}

function makeApp(overrides: Partial<Record<string, unknown>> = {}) {
  const container = {
    accountService: {
      listForUser: async () => [ACCOUNT],
      createOrg: async (_user: unknown, input: { name: string }) => ({
        ...ACCOUNT,
        name: input.name,
      }),
      updateSettings: async () => ACCOUNT,
      ...overrides,
    },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    c.set('user', {
      id: 'usr_1',
      login: 'octocat',
      name: null,
      avatarUrl: null,
      aud: 'session',
      exp: 0,
    })
    await next()
  })
  app.route('/', accountController())
  app.onError(handleError)
  return app
}

describe('accounts contracts (pilot)', () => {
  it('GET /accounts returns the user accounts', async () => {
    const res = await requestByContract(makeApp(), listAccountsContract, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([ACCOUNT])
  })

  it('POST /accounts validates + creates (201)', async () => {
    const res = await requestByContract(makeApp(), createAccountContract, {
      body: { name: 'New Org' },
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { name: string }).name).toBe('New Org')
  })

  it('PATCH /accounts/:accountId resolves the path param', async () => {
    const res = await requestByContract(makeApp(), updateAccountContract, {
      pathParams: { accountId: 'acc_1' },
      body: {},
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }).id).toBe('acc_1')
  })

  it('rejects an invalid body with the shared validation envelope (400)', async () => {
    // Bypass requestByContract's client-side validation to exercise the server validator.
    const res = await makeApp().request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }), // fails minLength(1)
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation')
  })
})
