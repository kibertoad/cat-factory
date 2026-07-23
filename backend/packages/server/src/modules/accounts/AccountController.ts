import {
  addAccountApiKeyContract,
  addAccountMemberContract,
  connectEmailContract,
  createAccountContract,
  createInvitationContract,
  disconnectEmailContract,
  getAccountSettingsContract,
  getEmailConnectionContract,
  listAccountApiKeysContract,
  listAccountMembersContract,
  listAccountsContract,
  listInvitationsContract,
  removeAccountApiKeyContract,
  revokeInvitationContract,
  setMemberRolesContract,
  testEmailContract,
  updateAccountApiKeyContract,
  updateAccountContract,
  updateAccountSettingsContract,
} from '@cat-factory/contracts'
import { ConflictError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { apiKeyToWire } from '../providers/ApiKeyController.js'

/**
 * The signed-in user, narrowed to what the tenancy layer needs. Generic over the
 * env so it accepts a contract-typed handler context (`ContractEnv<T> & AppEnv`),
 * which Hono treats as a distinct, non-assignable env from the bare `AppEnv`.
 */
function accountUser<E extends AppEnv>(c: Context<E>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unauthorized', message: 'Sign in to manage accounts' } }, 401)

/**
 * Account tenancy: the accounts a user can switch between (their personal account
 * plus any orgs they belong to), org creation, and membership management. Accounts
 * are an authenticated concept; with auth disabled (no signed-in user) there is a
 * single implicit dev context, so the list is empty and mutations are refused.
 *
 * Every route is mounted from its `@cat-factory/contracts` contract via
 * `buildHonoRoute`: the method/path and request validation come from the contract,
 * and `c.req.valid(...)` + the `c.json(body, status)` return are typed from it.
 */
export function accountController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listAccountsContract, async (c) => {
    const user = accountUser(c)
    if (!user) return c.json([], 200)
    return c.json(await c.get('container').accountService.listForUser(user), 200)
  })

  buildHonoRoute(app, createAccountContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const account = await c.get('container').accountService.createOrg(user, c.req.valid('json'))
    return c.json(account, 201)
  })

  buildHonoRoute(app, updateAccountContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const account = await c
      .get('container')
      .accountService.updateSettings(c.req.valid('param').accountId, user.id, c.req.valid('json'))
    return c.json(account, 200)
  })

  buildHonoRoute(app, listAccountMembersContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const accounts = c.get('container').accountService
    const { accountId } = c.req.valid('param')
    // Membership in the account is required to see its roster (404 otherwise).
    await accounts.requireMember(accountId, user.id)
    return c.json(await accounts.members(accountId), 200)
  })

  buildHonoRoute(app, addAccountMemberContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const body = c.req.valid('json')
    const member = await c
      .get('container')
      .accountService.addMember(c.req.valid('param').accountId, user.id, body.userId, body.roles)
    return c.json(member, 201)
  })

  // Set a member's role set (admin-only). The acting admin can't drop their own admin.
  buildHonoRoute(app, setMemberRolesContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const { accountId, userId } = c.req.valid('param')
    const member = await c
      .get('container')
      .accountService.setMemberRoles(accountId, user.id, userId, c.req.valid('json').roles)
    return c.json(member, 200)
  })

  // ---- Invitations (email-based org onboarding) ---------------------------
  // Available only when the invitation repository is wired (opt-in feature).

  buildHonoRoute(app, listInvitationsContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.invitations) return c.json([], 200)
    const { accountId } = c.req.valid('param')
    // Membership is required to view the account's pending invitations.
    await container.accountService.requireMember(accountId, user.id)
    return c.json(await container.invitations.list(accountId), 200)
  })

  buildHonoRoute(app, createInvitationContract, async (c) => {
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
      c.req.valid('param').accountId,
      user.id,
      body.email,
      body.roles,
    )
    // The raw accept link is returned so an operator can share it manually when no
    // email transport is configured; never re-derivable afterwards.
    return c.json({ invitation: created.invitation, acceptUrl: created.acceptUrl }, 201)
  })

  buildHonoRoute(app, revokeInvitationContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.invitations) return c.body(null, 204)
    const { accountId, invitationId } = c.req.valid('param')
    await container.invitations.revoke(accountId, user.id, invitationId)
    return c.body(null, 204)
  })

  // ---- Account-scoped provider API keys (admin-onboarded, shared org pool) ----
  // Direct-provider keys (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot) shared by every
  // workspace in the account. Admin-gated like the other account-scoped credentials;
  // the raw key is write-only — only secret-free metadata is ever returned. Available
  // only when the API-key store is wired (ENCRYPTION_KEY).

  const apiKeysUnavailable = <E extends AppEnv>(c: Context<E>) =>
    c.json({ error: { code: 'unavailable', message: 'API key storage is not configured' } }, 503)

  buildHonoRoute(app, listAccountApiKeysContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const keys = await container.apiKeys.listKeys('account', accountId)
    return c.json({ keys: keys.map(apiKeyToWire) }, 200)
  })

  buildHonoRoute(app, addAccountApiKeyContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const summary = await container.apiKeys.addKey('account', accountId, c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 201)
  })

  buildHonoRoute(app, updateAccountApiKeyContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    const { accountId, id } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const summary = await container.apiKeys.updateKey('account', accountId, id, c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 200)
  })

  buildHonoRoute(app, removeAccountApiKeyContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.apiKeys) return apiKeysUnavailable(c)
    const { accountId, id } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    await container.apiKeys.removeKey('account', accountId, id)
    return c.body(null, 204)
  })

  // ---- Email sender connection (per-account, UI-onboarded) ----------------
  // Owner-only mutations; available only when the email module is wired.

  buildHonoRoute(app, getEmailConnectionContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) return c.json({ connection: null, configured: false }, 200)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireMember(accountId, user.id)
    const connection = await container.email.getConnection(accountId)
    return c.json({ connection, configured: true }, 200)
  })

  buildHonoRoute(app, connectEmailContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) {
      return c.json({ error: { code: 'unavailable', message: 'Email is not configured' } }, 503)
    }
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const connection = await container.email.connect(accountId, c.req.valid('json'))
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectEmailContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) return c.body(null, 204)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    await container.email.disconnect(accountId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, testEmailContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.email) {
      return c.json({ error: { code: 'unavailable', message: 'Email is not configured' } }, 503)
    }
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    await container.email.sendTest(accountId, c.req.valid('json').to)
    return c.json({ ok: true }, 200)
  })

  // ---- Deployment settings (per-account, admin-only) ----------------------
  // The integration secrets (Slack OAuth / web-search / Langfuse) + tuning (retention,
  // inline web search) moved out of env onto a per-account row. Secrets are write-only:
  // GET returns only the non-secret config + presence summary. Available only when the
  // settings store is wired (ENCRYPTION_KEY). Admin-gated for BOTH read and write —
  // these are sensitive deployment knobs.

  const settingsUnavailable = <E extends AppEnv>(c: Context<E>) =>
    c.json(
      { error: { code: 'unavailable', message: 'Account settings storage is not configured' } },
      503,
    )

  buildHonoRoute(app, getAccountSettingsContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.accountSettings) return settingsUnavailable(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    return c.json(await container.accountSettings.service.read(accountId), 200)
  })

  buildHonoRoute(app, updateAccountSettingsContract, async (c) => {
    const user = accountUser(c)
    if (!user) return signInRequired(c)
    const container = c.get('container')
    if (!container.accountSettings) return settingsUnavailable(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const input = c.req.valid('json')
    // The account-wide model-family policy is a hosted/mothership-only control (no account
    // admin governs a single-developer local machine). Refuse to STORE a non-`off` policy
    // where the deployment doesn't support it, so a policy can never be set-but-ignored.
    if (
      input.config?.modelPolicy &&
      input.config.modelPolicy.mode !== 'off' &&
      !(container.config.infrastructure?.modelPolicy?.supported ?? false)
    ) {
      throw new ConflictError(
        'The account-wide model-family policy is not available on this deployment (it is a ' +
          'hosted / mothership-mode feature, not plain local mode).',
        'model_policy_unsupported',
      )
    }
    const view = await container.accountSettings.service.write(accountId, input)
    // The write may have changed the account's model-family policy; drop the cached read so
    // the `/models` catalog + start guard see it at once (cross-node when a bus is wired).
    await container.caches.accountModelPolicy.invalidate(accountId, accountId)
    return c.json(view, 200)
  })

  return app
}
