import {
  connectSlackByTokenSchema,
  updateSlackMemberMappingSchema,
  updateSlackSettingsSchema,
} from '@cat-factory/contracts'
import type { SlackModule } from '@cat-factory/orchestration'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { StateSigner } from '../../github/state.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

// The bot scopes the "Add to Slack" flow requests: post messages + read channels
// (public + private) so the routing picker can list them. `chat:write.public` lets
// the bot post to PUBLIC channels it hasn't been explicitly invited to — without it
// a routed public channel silently rejects every message (`not_in_channel`).
// Private channels still require an invite (Slack offers no public-write analogue).
const SLACK_BOT_SCOPES = ['chat:write', 'chat:write.public', 'channels:read', 'groups:read']

/** Resolve the Slack module or send a 503, returning null when unconfigured. */
function requireSlack(c: Context<AppEnv>): SlackModule | null {
  return c.get('container').slack ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Slack integration is not configured' } }, 503)

/**
 * Workspace-scoped Slack endpoints: per-account connection management (manual
 * bot-token paste + the OAuth "Add to Slack" URL), per-workspace notification
 * routing, the per-account member mapping, and the channel picker. The OAuth
 * callback itself is public (see {@link slackOAuthController}) since Slack
 * redirects the browser to it. Mounted under `/workspaces/:workspaceId`.
 */
export function slackController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- connection (per-account) ------------------------------------------

  app.get('/slack/connection', async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const connection = await slack.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection, oauthEnabled: slack.connectionService.oauthEnabled })
  })

  // The "Add to Slack" URL, carrying an HMAC-signed `state` that binds the install
  // to this workspace + user with a short expiry. 503 when OAuth isn't configured
  // (the manual-token path below is then the way to connect).
  app.get('/slack/install-url', async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    if (!slack.connectionService.oauthEnabled) {
      return c.json(
        { error: { code: 'unavailable', message: 'Slack OAuth is not configured' } },
        503,
      )
    }
    const signer = new StateSigner(c.get('container').config.auth.sessionSecret)
    const state = await signer.sign({
      workspaceId: param(c, 'workspaceId'),
      userId: c.get('user')?.id ?? null,
      exp: Date.now() + 10 * 60 * 1000,
    })
    const url = slack.connectionService.buildInstallUrl(state, SLACK_BOT_SCOPES)
    return c.json({ url })
  })

  // Manual bot-token paste (the always-available fallback to OAuth).
  app.post('/slack/connect', jsonBody(connectSlackByTokenSchema), async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const connection = await slack.connectionService.connectWithToken(
      param(c, 'workspaceId'),
      c.req.valid('json').token,
    )
    return c.json(connection, 201)
  })

  app.delete('/slack/connection', async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    await slack.connectionService.disconnect(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // Channels the bot can post to, for the routing picker.
  app.get('/slack/channels', async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const channels = await slack.connectionService.listChannels(param(c, 'workspaceId'))
    return c.json({ channels })
  })

  // ---- routing (per-workspace) -------------------------------------------

  app.get('/slack/settings', async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const settings = await slack.settingsService.get(param(c, 'workspaceId'))
    return c.json(settings)
  })

  app.put('/slack/settings', jsonBody(updateSlackSettingsSchema), async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const settings = await slack.settingsService.update(
      param(c, 'workspaceId'),
      c.req.valid('json'),
    )
    return c.json(settings)
  })

  // ---- member mapping (per-account) --------------------------------------

  app.get('/slack/member-mapping', async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const entries = await slack.memberMappingService.get(param(c, 'workspaceId'))
    return c.json({ entries })
  })

  app.put('/slack/member-mapping', jsonBody(updateSlackMemberMappingSchema), async (c) => {
    const slack = requireSlack(c)
    if (!slack) return unavailable(c)
    const entries = await slack.memberMappingService.update(
      param(c, 'workspaceId'),
      c.req.valid('json').entries,
    )
    return c.json({ entries })
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
    const slack = container.slack
    if (!slack) return unavailable(c)

    const code = c.req.query('code')
    if (!code) {
      return c.json({ error: { code: 'validation', message: 'Missing code' } }, 400)
    }
    const signer = new StateSigner(container.config.auth.sessionSecret)
    const state = await signer.verify(c.req.query('state') ?? null)
    if (!state) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired state' } }, 401)
    }

    await slack.connectionService.connectViaOAuth(state.workspaceId, code)
    // Land back on the app (reuse the GitHub setup redirect target as the app URL).
    return c.redirect(container.config.github.setupRedirectUrl || '/')
  })

  return app
}
