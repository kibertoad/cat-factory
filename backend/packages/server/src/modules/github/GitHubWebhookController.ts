import { Hono } from 'hono'
import { StateSigner } from '../../github/state.js'
import type { AppEnv } from '../../http/env.js'

/**
 * Public GitHub-facing endpoints (NOT under /workspaces, since GitHub calls
 * them): the webhook receiver and the App setup callback. Mounted at `/github`.
 *
 * The webhook receiver verifies the HMAC signature over the *raw* body before
 * anything else, acks fast by handing the delivery to the facade's webhook-ingest
 * gateway for async projection (falling back to inline handling when no async
 * consumer is wired, e.g. local dev), and never blocks GitHub on projection work.
 */
export function githubWebhookController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/webhooks', async (c) => {
    const github = c.get('container').github
    if (!github)
      return c.json({ error: { code: 'unavailable', message: 'GitHub not configured' } }, 503)

    // Verify against the raw bytes before parsing.
    const raw = await c.req.arrayBuffer()
    const ok = await github.webhookVerifier.verify(raw, c.req.header('x-hub-signature-256') ?? null)
    if (!ok) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid signature' } }, 401)
    }

    const eventName = c.req.header('x-github-event') ?? ''
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return c.json({ error: { code: 'validation', message: 'Invalid JSON body' } }, 400)
    }

    // Hand off for async projection; if no async consumer is wired, apply inline so
    // local/dev still works.
    const queued = await c
      .get('container')
      .gateways.githubWebhook.enqueueWebhook(eventName, payload)
    if (!queued) await github.webhookService.handle(eventName, payload)
    return c.body(null, 202)
  })

  // GitHub redirects here after an installation. On a fresh install we carry the
  // HMAC-signed `state` (the workspace id we issued) that binds the installation
  // to that workspace. But GitHub also redirects here for STATELESS actions —
  // notably a repo-access change saved straight from the App's installation
  // settings page (`setup_action=update`), which carries no `state`. We can't
  // bind a NEW installation without a signed workspace id, but if it's already
  // bound we recover the workspace and treat the redirect as a resync — so newly
  // granted repos get picked up instead of dead-ending on "invalid state".
  app.get('/setup/callback', async (c) => {
    const container = c.get('container')
    const github = container.github
    if (!github)
      return c.json({ error: { code: 'unavailable', message: 'GitHub not configured' } }, 503)

    const installationId = Number(c.req.query('installation_id'))
    if (!Number.isFinite(installationId)) {
      return c.json({ error: { code: 'validation', message: 'Missing installation_id' } }, 400)
    }

    const signer = new StateSigner(container.config.github.webhookSecret)
    const state = await signer.verify(c.req.query('state') ?? null)
    // No (valid) state → only proceed if this installation is already bound;
    // binding a brand-new installation still requires a signed state.
    const workspaceId =
      state?.workspaceId ?? (await github.installationService.resolveBoundWorkspace(installationId))
    if (!workspaceId) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired state' } }, 401)
    }

    await github.installationService.connect(workspaceId, installationId)

    // Repos are linked explicitly per workspace after connecting, so there is no
    // whole-installation backfill here — the user picks which repos this board
    // tracks, which projects and syncs just those.

    return c.redirect(container.config.github.setupRedirectUrl)
  })

  return app
}
