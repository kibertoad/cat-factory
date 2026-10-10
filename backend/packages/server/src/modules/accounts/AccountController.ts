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
import { requireCapability, requireUser } from '../../http/guards.js'
import { registerAuditLogRoutes } from './auditLogRoutes.js'

/**
 * The signed-in user, narrowed to what the tenancy layer needs, or a 401 — every route here
 * is account-scoped and has nothing to answer for an anonymous caller. Contrast
 * `WorkspaceController`'s `optionalAccountUser`, which is deliberately nullable because board
 * listing still answers with no signed-in user (dev-open). Generic over the env so it accepts a
 * contract-typed handler context (`ContractEnv<T> & AppEnv`), which Hono treats as a distinct,
 * non-assignable env from the bare `AppEnv`.
 */
function requireAccountUser<E extends AppEnv>(c: Context<E>) {
  const user = requireUser(c, 'Sign in to manage accounts')
  return { id: user.id, login: user.login, name: user.name }
}

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
/** Resolve the account-scoped API-key store, or refuse with a 503. */
function requireApiKeys<E extends AppEnv>(c: Context<E>) {
  return requireCapability(c.get('container').apiKeys, 'API key storage is not configured')
}

/** Resolve the account-settings store, or refuse with a 503. */
function requireAccountSettings<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').accountSettings,
    'Account settings storage is not configured',
  )
}

export function accountController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listAccountsContract, async (c) => {
    const user = requireAccountUser(c)
    if (!user) return c.json([], 200)
    return c.json(await c.get('container').accountService.listForUser(user), 200)
  })

  buildHonoRoute(app, createAccountContract, async (c) => {
    const user = requireAccountUser(c)
    const account = await c.get('container').accountService.createOrg(user, c.req.valid('json'))
    return c.json(account, 201)
  })

  buildHonoRoute(app, updateAccountContract, async (c) => {
    const user = requireAccountUser(c)
    const account = await c
      .get('container')
      .accountService.updateSettings(c.req.valid('param').accountId, user.id, c.req.valid('json'))
    return c.json(account, 200)
  })

  buildHonoRoute(app, listAccountMembersContract, async (c) => {
    const user = requireAccountUser(c)
    const accounts = c.get('container').accountService
    const { accountId } = c.req.valid('param')
    // Membership in the account is required to see its roster (404 otherwise).
    await accounts.requireMember(accountId, user.id)
    return c.json(await accounts.members(accountId), 200)
  })

  buildHonoRoute(app, addAccountMemberContract, async (c) => {
    const user = requireAccountUser(c)
    const body = c.req.valid('json')
    const member = await c
      .get('container')
      .accountService.addMember(c.req.valid('param').accountId, user.id, body.userId, body.roles)
    return c.json(member, 201)
  })

  // Set a member's role set (admin-only). The acting admin can't drop their own admin.
  buildHonoRoute(app, setMemberRolesContract, async (c) => {
    const user = requireAccountUser(c)
    const { accountId, userId } = c.req.valid('param')
    const member = await c
      .get('container')
      .accountService.setMemberRoles(accountId, user.id, userId, c.req.valid('json').roles)
    return c.json(member, 200)
  })

  // The audit log's read surface + the admin-forced session revocation that writes to it. Their
  // own registrar (`auditLogRoutes.ts`) so this function stays inside the per-function budget;
  // the paths still live under the account prefix.
  registerAuditLogRoutes(app)

  // ---- Invitations (email-based org onboarding) ---------------------------
  // Available only when the invitation repository is wired (opt-in feature).

  buildHonoRoute(app, listInvitationsContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    if (!container.invitations) return c.json([], 200)
    const { accountId } = c.req.valid('param')
    // Membership is required to view the account's pending invitations.
    await container.accountService.requireMember(accountId, user.id)
    return c.json(await container.invitations.list(accountId), 200)
  })

  buildHonoRoute(app, createInvitationContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const invitations = requireCapability(container.invitations, 'Invitations are not configured')
    const body = c.req.valid('json')
    const created = await invitations.invite(
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
    const user = requireAccountUser(c)
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

  buildHonoRoute(app, listAccountApiKeysContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const apiKeys = requireApiKeys(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const keys = await apiKeys.listKeys('account', accountId)
    return c.json({ keys: keys.map(apiKeyToWire) }, 200)
  })

  buildHonoRoute(app, addAccountApiKeyContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const apiKeys = requireApiKeys(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const summary = await apiKeys.addKey('account', accountId, c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 201)
  })

  buildHonoRoute(app, updateAccountApiKeyContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const apiKeys = requireApiKeys(c)
    const { accountId, id } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const summary = await apiKeys.updateKey('account', accountId, id, c.req.valid('json'))
    return c.json(apiKeyToWire(summary), 200)
  })

  buildHonoRoute(app, removeAccountApiKeyContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const apiKeys = requireApiKeys(c)
    const { accountId, id } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    await apiKeys.removeKey('account', accountId, id)
    return c.body(null, 204)
  })

  // ---- Email sender connection (per-account, UI-onboarded) ----------------
  // Owner-only mutations; available only when the email module is wired.

  buildHonoRoute(app, getEmailConnectionContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    if (!container.email) return c.json({ connection: null, configured: false }, 200)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireMember(accountId, user.id)
    const connection = await container.email.getConnection(accountId)
    return c.json({ connection, configured: true }, 200)
  })

  buildHonoRoute(app, connectEmailContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const email = requireCapability(container.email, 'Email is not configured')
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const connection = await email.connect(accountId, c.req.valid('json'))
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectEmailContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    if (!container.email) return c.body(null, 204)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    await container.email.disconnect(accountId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, testEmailContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const email = requireCapability(container.email, 'Email is not configured')
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    await email.sendTest(accountId, c.req.valid('json').to)
    return c.json({ ok: true }, 200)
  })

  // ---- Deployment settings (per-account, admin-only) ----------------------
  // The integration secrets (Slack OAuth / web-search / Langfuse) + tuning (retention,
  // inline web search) moved out of env onto a per-account row. Secrets are write-only:
  // GET returns only the non-secret config + presence summary. Available only when the
  // settings store is wired (ENCRYPTION_KEY). Admin-gated for BOTH read and write —
  // these are sensitive deployment knobs.

  buildHonoRoute(app, getAccountSettingsContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const accountSettings = requireAccountSettings(c)
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    return c.json(await accountSettings.service.read(accountId), 200)
  })

  buildHonoRoute(app, updateAccountSettingsContract, async (c) => {
    const user = requireAccountUser(c)
    const container = c.get('container')
    const accountSettings = requireAccountSettings(c)
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
    const view = await accountSettings.service.write(accountId, input)
    // The write may have changed the account's model-family policy; drop the cached read so
    // the `/models` catalog + start guard see it at once (cross-node when a bus is wired).
    await container.caches.accountModelPolicy.invalidate(accountId, accountId)
    return c.json(view, 200)
  })

  return app
}
