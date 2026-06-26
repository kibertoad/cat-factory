import {
  addApiKeySchema,
  addMemberSchema,
  connectEmailSchema,
  createAccountSchema,
  createInvitationSchema,
  setMemberRolesSchema,
  testEmailSchema,
  updateAccountSchema,
  updateAccountSettingsSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'
import { apiKeyToWire } from '../providers/ApiKeyController.js'

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

  app.patch('/accounts/:accountId', jsonBody(updateAccountSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const account = await c
      .get('container')
      .accountService.updateSettings(param(c, 'accountId'), user.id, c.req.valid('json'))
    return c.json(account)
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
      .accountService.addMember(param(c, 'accountId'), user.id, body.userId, body.roles)
    return c.json(member, 201)
  })

  // Set a member's role set (admin-only). The acting admin can't drop their own admin.
  app.patch(
    '/accounts/:accountId/members/:userId/roles',
    jsonBody(setMemberRolesSchema),
    async (c) => {
      const user = accountUser(c)
      if (!user) return signInRequired(c)
      const member = await c
        .get('container')
        .accountService.setMemberRoles(
          param(c, 'accountId'),
          user.id,
          param(c, 'userId'),
          c.req.valid('json').roles,
        )
      return c.json(member)
    },
  )

  // ---- Invitations (email-based org onboarding) ---------------------------
  // Available only when the invitation repository is wired (opt-in feature).

  app.get('/accounts/:accountId/invitations', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.invitations) return c.json([])
    // Membership is required to view the account's pending invitations.
    await container.accountService.requireMember(param(c, 'accountId'), user.id)
    return c.json(await container.invitations.list(param(c, 'accountId')))
  })

  app.post('/accounts/:accountId/invitations', jsonBody(createInvitationSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.invitations) {
      return c.json(
        { error: { code: 'unavailable', message: 'Invitations are not configured' } },
        503,
      )
    }
    const body = c.req.valid('json')
    const created = await container.invitations.invite(
      param(c, 'accountId'),
      user.id,
      body.email,
      body.roles,
    )
    // The raw accept link is returned so an operator can share it manually when no
    // email transport is configured; never re-derivable afterwards.
    return c.json({ invitation: created.invitation, acceptUrl: created.acceptUrl }, 201)
  })

  app.delete('/accounts/:accountId/invitations/:invitationId', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.invitations) return c.body(null, 204)
    await container.invitations.revoke(param(c, 'accountId'), user.id, param(c, 'invitationId'))
    return c.body(null, 204)
  })

  // ---- Account-scoped provider API keys (admin-onboarded, shared org pool) ----
  // Direct-provider keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot) shared by every
  // workspace in the account. Admin-gated like the other account-scoped credentials;
  // the raw key is write-only — only secret-free metadata is ever returned. Available
  // only when the API-key store is wired (ENCRYPTION_KEY).

  const apiKeysUnavailable = (c: Context<AppEnv>) =>
    c.json({ error: { code: 'unavailable', message: 'API key storage is not configured' } }, 503)

  app.get('/accounts/:accountId/api-keys', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    await container.accountService.requireAdmin(param(c, 'accountId'), user.id)
    const keys = await container.apiKeys.listKeys('account', param(c, 'accountId'))
    return c.json({ keys: keys.map(apiKeyToWire) })
  })

  app.post('/accounts/:accountId/api-keys', jsonBody(addApiKeySchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    await container.accountService.requireAdmin(param(c, 'accountId'), user.id)
    const summary = await container.apiKeys.addKey(
      'account',
      param(c, 'accountId'),
      c.req.valid('json'),
    )
    return c.json(apiKeyToWire(summary), 201)
  })

  app.delete('/accounts/:accountId/api-keys/:id', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    await container.accountService.requireAdmin(param(c, 'accountId'), user.id)
    await container.apiKeys.removeKey('account', param(c, 'accountId'), param(c, 'id'))
    return c.body(null, 204)
  })

  // ---- Email sender connection (per-account, UI-onboarded) ----------------
  // Owner-only mutations; available only when the email module is wired.

  app.get('/accounts/:accountId/email-connection', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) return c.json({ connection: null, configured: false })
    await container.accountService.requireMember(param(c, 'accountId'), user.id)
    const connection = await container.email.getConnection(param(c, 'accountId'))
    return c.json({ connection, configured: true })
  })

  app.post('/accounts/:accountId/email-connection', jsonBody(connectEmailSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) {
      return c.json({ error: { code: 'unavailable', message: 'Email is not configured' } }, 503)
    }
    await c.get('container').accountService.requireAdmin(param(c, 'accountId'), user.id)
    const connection = await container.email.connect(param(c, 'accountId'), c.req.valid('json'))
    return c.json(connection, 201)
  })

  app.delete('/accounts/:accountId/email-connection', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) return c.body(null, 204)
    await c.get('container').accountService.requireAdmin(param(c, 'accountId'), user.id)
    await container.email.disconnect(param(c, 'accountId'))
    return c.body(null, 204)
  })

  app.post('/accounts/:accountId/email-connection/test', jsonBody(testEmailSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) {
      return c.json({ error: { code: 'unavailable', message: 'Email is not configured' } }, 503)
    }
    await c.get('container').accountService.requireAdmin(param(c, 'accountId'), user.id)
    await container.email.sendTest(param(c, 'accountId'), c.req.valid('json').to)
    return c.json({ ok: true })
  })

  // ---- Deployment settings (per-account, admin-only) ----------------------
  // The integration secrets (Slack OAuth / web-search / Langfuse) + tuning (retention,
  // inline web search) moved out of env onto a per-account row. Secrets are write-only:
  // GET returns only the non-secret config + presence summary. Available only when the
  // settings store is wired (ENCRYPTION_KEY). Admin-gated for BOTH read and write —
  // these are sensitive deployment knobs.

  const settingsUnavailable = (c: Context<AppEnv>) =>
    c.json(
      { error: { code: 'unavailable', message: 'Account settings storage is not configured' } },
      503,
    )

  app.get('/accounts/:accountId/settings', async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.accountSettings) return settingsUnavailable(c)
    await container.accountService.requireAdmin(param(c, 'accountId'), user.id)
    return c.json(await container.accountSettings.service.read(param(c, 'accountId')))
  })

  app.put('/accounts/:accountId/settings', jsonBody(updateAccountSettingsSchema), async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.accountSettings) return settingsUnavailable(c)
    await container.accountService.requireAdmin(param(c, 'accountId'), user.id)
    return c.json(
      await container.accountSettings.service.write(param(c, 'accountId'), c.req.valid('json')),
    )
  })

  return app
}
