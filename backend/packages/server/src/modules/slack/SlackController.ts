import {
  connectSlackContract,
  disconnectSlackContract,
  getSlackConnectionContract,
  getSlackInstallUrlContract,
  getSlackMemberMappingContract,
  getSlackSettingsContract,
  listSlackChannelsContract,
  updateSlackMemberMappingContract,
  updateSlackSettingsContract,
} from '@cat-factory/contracts'
import type { SlackModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { StateSigner } from '../../github/state.js'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { UnavailableError, UnauthorizedError } from '@cat-factory/kernel'
import { requireCapability } from '../../http/guards.js'

// The bot scopes the "Add to Slack" flow requests: post messages + read channels
// (public + private) so the routing picker can list them. `chat:write.public` lets
// the bot post to PUBLIC channels it hasn't been explicitly invited to — without it
// a routed public channel silently rejects every message (`not_in_channel`).
// Private channels still require an invite (Slack offers no public-write analogue).
const SLACK_BOT_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read']

/** Resolve the Slack module, or refuse with a 503 naming what isn't wired. */
function requireSlack<E extends AppEnv>(c: Context<E>): SlackModule {
  return requireCapability(c.get('container').slack, 'Slack integration is not configured')
}

/**
 * Workspace-scoped Slack endpoints: per-account connection management (manual
 * bot-token paste + the OAuth "Add to Slack" URL), per-workspace notification
 * routing, the per-account member mapping, and the channel picker. The OAuth
 * callback itself is public (see {@link slackOAuthController}) since Slack
 * redirects the browser to it. Mounted under `/workspaces/:workspaceId`.
 */
export function slackController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/slack'])

  // ---- connection (per-account) ------------------------------------------

  buildHonoRoute(app, getSlackConnectionContract, async (c) => {
    const slack = requireSlack(c)
    const connection = await slack.connectionService.getConnection(param(c, 'workspaceId'))
    const oauthEnabled = await slack.connectionService.oauthEnabled(param(c, 'workspaceId'))
    return c.json({ connection, oauthEnabled }, 200)
  })

  // The "Add to Slack" URL, carrying an HMAC-signed `state` that binds the install
  // to this workspace + user with a short expiry. 503 when OAuth isn't configured
  // (the manual-token path below is then the way to connect).
  buildHonoRoute(app, getSlackInstallUrlContract, async (c) => {
    const slack = requireSlack(c)
    const workspaceId = param(c, 'workspaceId')
    if (!(await slack.connectionService.oauthEnabled(workspaceId))) {
      throw new UnavailableError('Slack OAuth is not configured')
    }
    const signer = new StateSigner(c.get('container').config.auth.sessionSecret)
    const state = await signer.sign({
      workspaceId,
      userId: c.get('user')?.id ?? null,
      exp: Date.now() + 10 * 60 * 1000,
    })
    const url = await slack.connectionService.buildInstallUrl(workspaceId, state, SLACK_BOT_SCOPES)
    return c.json({ url }, 200)
  })

  // Manual bot-token paste (the always-available fallback to OAuth).
  buildHonoRoute(app, connectSlackContract, async (c) => {
    const slack = requireSlack(c)
    const connection = await slack.connectionService.connectWithToken(
      param(c, 'workspaceId'),
      c.req.valid('json').token,
    )
    return c.json(connection, 201)
  })

  buildHonoRoute(app, disconnectSlackContract, async (c) => {
    const slack = requireSlack(c)
    await slack.connectionService.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // Channels the bot can post to, for the routing picker.
  buildHonoRoute(app, listSlackChannelsContract, async (c) => {
    const slack = requireSlack(c)
    const channels = await slack.connectionService.listChannels(param(c, 'workspaceId'))
    return c.json({ channels }, 200)
  })

  // ---- routing (per-workspace) -------------------------------------------

  buildHonoRoute(app, getSlackSettingsContract, async (c) => {
    const slack = requireSlack(c)
    const settings = await slack.settingsService.get(param(c, 'workspaceId'))
    return c.json(settings, 200)
  })

  buildHonoRoute(app, updateSlackSettingsContract, async (c) => {
    const slack = requireSlack(c)
    const settings = await slack.settingsService.update(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(settings, 200)
  })

  // ---- member mapping (per-account) --------------------------------------

  buildHonoRoute(app, getSlackMemberMappingContract, async (c) => {
    const slack = requireSlack(c)
    const entries = await slack.memberMappingService.get(param(c, 'workspaceId'))
    return c.json({ entries }, 200)
  })

  buildHonoRoute(app, updateSlackMemberMappingContract, async (c) => {
    const slack = requireSlack(c)
    const entries = await slack.memberMappingService.update(
      param(c, 'workspaceId'),
      c.req.valid('json').entries,
    )
    return c.json({ entries }, 200)
  })

  return app
}

/**
 * Public Slack OAuth callback (Slack redirects the browser here with `?code&state`,
 * so it can't be workspace-scoped or session-gated; the `state` is HMAC-verified).
 * Mounted at `/slack`. Mirrors the GitHub `/github/setup/callback` flow.
 */
export function slackOAuthController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/oauth/callback', async (c) => {
    const container = c.get('container')
    const slack = requireCapability(container.slack, 'Slack integration is not configured')

    const code = c.req.query('code')
    if (!code) {
      return c.json({ error: { code: 'validation', message: 'Missing code' } }, 400)
    }
    const signer = new StateSigner(container.config.auth.sessionSecret)
    const state = await signer.verify(c.req.query('state') ?? null)
    if (!state) {
      throw new UnauthorizedError('Invalid or expired state')
    }

    await slack.connectionService.connectViaOAuth(state.workspaceId, code)
    // Land back on the app (reuse the GitHub setup redirect target as the app URL).
    return c.redirect(container.config.github.setupRedirectUrl || '/')
  })

  return app
}
