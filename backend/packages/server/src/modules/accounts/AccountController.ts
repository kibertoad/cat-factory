import { addMemberSchema, createAccountSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** The signed-in user, narrowed to what the tenancy layer needs. */
function accountUser(c: Context<AppEnv>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

const signInRequired = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage accounts' } }, 401)

/**
 * Account tenancy: the accounts a user can switch between (their personal account
 * plus any orgs they belong to), org creation, and membership management. Accounts
 * are an authenticated concept; with auth disabled (no signed-in user) there is a
 * single implicit dev context, so the list is empty and mutations are refused.
 */
export function accountController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/accounts', async (c) => {
    const user = accountUser(c)
    if (!user) return c.json([])
    return c.json(await c.get('container').accountService.listForUser(user))
  })

  app.post('/accounts', jsonBody(createAccountSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const account = await c.get('container').accountService.createOrg(user, c.req.valid('json'))
    return c.json(account, 201)
  })

  app.get('/accounts/:accountId/members', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const accounts = c.get('container').accountService
    // Membership in the account is required to see its roster (404 otherwise).
    await accounts.requireMember(param(c, 'accountId'), user.id)
    return c.json(await accounts.members(param(c, 'accountId')))
  })

  app.post('/accounts/:accountId/members', jsonBody(addMemberSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const body = c.req.valid('json')
    const member = await c
      .get('container')
      .accountService.addMember(param(c, 'accountId'), user.id, body.userId, body.role)
    return c.json(member, 201)
  })

  return app
}
