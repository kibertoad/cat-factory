import { Hono } from 'hono'
import { getVcsProvider, isVcsProvider } from '@cat-factory/kernel'
import type { VcsConnectionRef } from '@cat-factory/kernel'
import type { AppConfig } from '../../config/types.js'
import type { AppEnv } from '../../http/env.js'

/**
 * Provider-neutral webhook receiver for non-GitHub VCS systems (GitLab first). GitHub keeps
 * its own `/github/webhooks` route (HMAC + the GitHub-specific projection); this is the
 * neutral counterpart, mounted at `/vcs`, that drives any provider registered in the kernel
 * VCS registry through the SAME steps the GitHub route does — verify the signature over the
 * RAW body first, then map the delivery to a neutral {@link VcsWebhookEvent}, then hand it to
 * the facade's optional {@link VcsWebhookSink}. It acks fast (202) and never blocks the host.
 *
 * The connection is resolved by the receiver BEFORE mapping (per the `VcsWebhookMapper`
 * contract). For the single env-configured connection that is the provider's config entry
 * (e.g. `config.gitlab.connectionId`); a deployment with many connections would resolve it
 * from the payload's project + the stored webhook secret instead.
 */
export function vcsWebhookController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/:provider/webhooks', async (c) => {
    const providerParam = c.req.param('provider')
    if (!isVcsProvider(providerParam)) {
      return c.json({ error: { code: 'validation', message: 'Unknown VCS provider' } }, 404)
    }
    const bundle = getVcsProvider(providerParam)
    if (!bundle) {
      return c.json(
        { error: { code: 'unavailable', message: `${providerParam} is not configured` } },
        503,
      )
    }

    const connection = resolveConnection(c.get('container').config, providerParam)
    if (!connection) {
      return c.json(
        { error: { code: 'unavailable', message: `${providerParam} connection not configured` } },
        503,
      )
    }

    // Verify against the RAW bytes before parsing. Each provider keys off a different
    // header — GitLab's caller-chosen `X-Gitlab-Token`, GitHub's HMAC `X-Hub-Signature-256`.
    const raw = await c.req.arrayBuffer()
    const signatureHeader =
      c.req.header('x-gitlab-token') ?? c.req.header('x-hub-signature-256') ?? null
    if (!bundle.webhookVerifier) {
      return c.json(
        { error: { code: 'unavailable', message: 'Webhook verification not configured' } },
        503,
      )
    }
    if (!(await bundle.webhookVerifier.verify(raw, signatureHeader))) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid signature' } }, 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return c.json({ error: { code: 'validation', message: 'Invalid JSON body' } }, 400)
    }

    // Verified but no mapper ⇒ ack (nothing to normalise). Map, then hand off to the sink
    // when one is wired; a delivery the mapper doesn't recognise is dropped (acked).
    const mapper = bundle.webhookMapper
    if (mapper) {
      const eventName = c.req.header('x-gitlab-event') ?? c.req.header('x-github-event') ?? ''
      // Hono's `header()` (no arg) returns all headers with lower-cased keys.
      const event = mapper.map(connection, { eventName, payload, headers: c.req.header() })
      const sink = c.get('container').vcsWebhookSink
      if (event && sink) await sink.handle(event)
    }
    return c.body(null, 202)
  })

  return app
}

/** The single env-configured connection ref for a provider, or null when unconfigured. */
function resolveConnection(
  config: AppConfig,
  provider: 'github' | 'gitlab',
): VcsConnectionRef | null {
  if (provider === 'gitlab') {
    const gitlab = config.gitlab
    if (!gitlab?.enabled) return null
    return { provider: 'gitlab', connectionId: gitlab.connectionId }
  }
  // GitHub uses its dedicated `/github/webhooks` route; the neutral route does not serve it.
  return null
}
