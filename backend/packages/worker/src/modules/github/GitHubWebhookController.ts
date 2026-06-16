import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { StateSigner } from '../../infrastructure/github/state'

/**
 * Public GitHub-facing endpoints (NOT under /workspaces, since GitHub calls
 * them): the webhook receiver and the App setup callback. Mounted at `/github`.
 *
 * The webhook receiver verifies the HMAC signature over the *raw* body before
 * anything else, acks fast by enqueuing the delivery for async projection
 * (falling back to inline handling when no queue is bound, e.g. local dev), and
 * never blocks GitHub on projection work.
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

    const queue = c.env.GITHUB_SYNC_QUEUE
    if (queue) {
      await queue.send({ kind: 'webhook', eventName, payload })
    } else {
      // No queue bound: apply inline so local/dev still works.
      await github.webhookService.handle(eventName, payload)
    }
    return c.body(null, 202)
  })

  // GitHub redirects here after an installation. `state` is the HMAC-signed
  // workspace id we issued, which binds the new installation to that workspace.
  app.get('/setup/callback', async (c) => {
    const container = c.get('container')
    const github = container.github
    if (!github)
      return c.json({ error: { code: 'unavailable', message: 'GitHub not configured' } }, 503)

    const signer = new StateSigner(c.env.GITHUB_WEBHOOK_SECRET ?? '')
    const state = await signer.verify(c.req.query('state') ?? null)
    if (!state) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired state' } }, 401)
    }
    const workspaceId = state.workspaceId
    const installationId = Number(c.req.query('installation_id'))
    if (!Number.isFinite(installationId)) {
      return c.json({ error: { code: 'validation', message: 'Missing installation_id' } }, 400)
    }

    await github.installationService.connect(workspaceId, installationId)

    // Kick off an initial backfill: durable Workflow if available, else discover
    // repos now and let the cron pass fill in the per-repo detail.
    const workflow = c.env.GITHUB_BACKFILL_WORKFLOW
    if (workflow) {
      await workflow
        .create({ id: `backfill-${installationId}-${Date.now()}`, params: { installationId } })
        .catch(() => {})
    } else {
      await github.syncService.syncInstallationRepos(workspaceId, installationId)
    }

    return c.redirect(container.config.github.setupRedirectUrl)
  })

  return app
}
