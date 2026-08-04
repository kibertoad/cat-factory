import { Hono } from 'hono'
import {
  isTaskSourceKind,
  trackerWebhookSecret,
  UnavailableError,
  UnauthorizedError,
} from '@cat-factory/kernel'
import type { TrackerWebhookDelivery } from '@cat-factory/kernel'
import { webhookBodyLimit } from '../../webhooks/bodyLimit.js'
import { logger } from '../../observability/logger.js'
import type { AppEnv } from '../../http/env.js'

/**
 * Public tracker-facing webhook receiver — the PUSH counterpart of the polling task-source reads,
 * mounted at `/webhooks/tasks` beside the GitHub and neutral-VCS receivers.
 *
 * `POST /webhooks/tasks/:source/:workspaceId`
 *
 * **Why the workspace is in the path.** A tracker delivery carries no installation id to resolve a
 * workspace from (the GitHub App's trick), and Jira/Linear payloads carry only vendor-internal ids.
 * Scanning every workspace's connections for one whose secret verifies would be a deployment-wide
 * N+1 on every unauthenticated POST — a free amplification oracle. The workspace id is not a secret
 * (it is in every API path already); the per-connection `webhookSecret` is what authenticates. See
 * D1 of `backend/docs/adr/0032-tracker-webhook-intake.md`.
 *
 * The shape is otherwise the GitHub receiver's, step for step: verify over the RAW body before any
 * parse, ack fast (202), and hand the parsed event to the facade's queue — falling back to inline
 * handling when no async consumer is wired, so local/dev still works.
 */
export function taskWebhookController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/tasks/:source/:workspaceId', webhookBodyLimit(), async (c) => {
    const sourceParam = c.req.param('source')
    if (!isTaskSourceKind(sourceParam)) {
      return c.json({ error: { code: 'validation', message: 'Unknown task source' } }, 404)
    }
    const container = c.get('container')
    const tasks = container.tasks
    const trackerWebhook = container.trackerWebhook
    if (!tasks || !trackerWebhook) {
      throw new UnavailableError('Task sources are not configured')
    }

    // A provider with no webhook capability 404s rather than 503s: unlike an unconfigured
    // deployment this will never start working, so an operator who pasted the wrong URL should
    // learn immediately instead of watching deliveries be accepted into a void.
    const provider = tasks.connectionService.providerFor(sourceParam)
    if (!provider?.webhook) {
      return c.json(
        { error: { code: 'not_found', message: `${sourceParam} does not accept webhooks` } },
        404,
      )
    }

    const workspaceId = c.req.param('workspaceId')
    const connection = await tasks.connectionService.getConnectionRecord(workspaceId, sourceParam)
    const secret = trackerWebhookSecret(connection?.credentials)
    if (!secret) {
      // Fail CLOSED on an unconfigured secret: an empty HMAC key is one an attacker also has, so
      // this must never degrade to "accept anything". 503 (not 401) because the remedy is the
      // operator's — mint a secret on the connection — not the caller's.
      throw new UnavailableError('No webhook secret configured')
    }

    // Verify against the RAW bytes before parsing. Hono's `header()` (no arg) returns every header
    // with lower-cased keys, which is what the adapters' scheme names assume.
    const delivery: TrackerWebhookDelivery = {
      eventName: c.req.header('x-github-event') ?? c.req.header('linear-event') ?? '',
      headers: c.req.header(),
      raw: await c.req.arrayBuffer(),
    }
    if (!(await provider.webhook.verify(secret, delivery))) {
      // Response stays terse (external caller); log the operator-facing setup remedy. This does NOT
      // reuse `logWebhookSignatureRejection`: that helper's copy is keyed to the two VCS providers'
      // env-var-configured secrets, and a tracker secret is per WORKSPACE CONNECTION with an
      // entirely different remedy — pointing an operator at `GITHUB_WEBHOOK_SECRET` here would send
      // them to the wrong place.
      logger.warn(
        `A ${sourceParam} webhook delivery for workspace ${workspaceId} was rejected (401 Invalid ` +
          `signature). The secret configured on the tracker's webhook and the one stored on this ` +
          `workspace's ${sourceParam} connection differ — re-mint the secret via ` +
          `POST /workspaces/${workspaceId}/task-sources/${sourceParam}/webhook and paste the ` +
          `returned value into the tracker.`,
        { event: 'tracker_webhook_signature_rejected', source: sourceParam, workspaceId },
      )
      throw new UnauthorizedError('Invalid signature')
    }

    // Verified but unrecognised ⇒ ack. Trackers send far more event kinds than we consume, and
    // retrying a shape we will never act on just makes the vendor redeliver it forever.
    const event = provider.webhook.parse(delivery)
    if (!event) return c.body(null, 202)

    const queued = await container.gateways.trackerWebhook.enqueueEvent(workspaceId, event)
    if (!queued) await trackerWebhook.service.handle(workspaceId, event)
    return c.body(null, 202)
  })

  return app
}
