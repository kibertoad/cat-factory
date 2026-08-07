import {
  DEFAULT_NOTIFICATION_WEBHOOK_ID,
  deletePublicNamedNotificationWebhookContract,
  deletePublicNotificationWebhookContract,
  getPublicNamedNotificationWebhookContract,
  getPublicNotificationWebhookContract,
  listPublicNotificationWebhooksContract,
  putPublicNamedNotificationWebhookContract,
  putPublicNotificationWebhookContract,
} from '@cat-factory/contracts'
import type { NotificationWebhookService } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorize, refuse } from './publicApiAuth.js'

// The PUBLIC management surface for the OUTBOUND notification webhook
// (`/api/v1/notification-webhook`): the last piece of the push integration that a headless caller
// could not reach.
//
// The webhook is what makes an integration event-driven rather than poll-driven. Notifications,
// run-lifecycle edges and platform-health transitions are delivered to an endpoint the workspace
// registers, and until this controller that endpoint could only be registered over the
// session-authed `/workspaces/:ws/notification-webhook`. A deployment driven entirely by API keys
// therefore had to put a human in a browser to turn push on, for a feature whose whole reason to
// exist is that there is no browser. The delivery contract was headless; its enrolment was not.
//
// Three things shape this controller:
//
//  1. **`admin` scope on all three verbs, the read included.** The obvious alternative, `read` for
//     the GET since it returns no secret, buys an integration nothing it cannot get from its own
//     configuration, and the URL it discloses is a receiver's address plus, in practice, the
//     deployment's routing shape. What decides it is ADR 0034: a scope can be RELAXED later
//     without breaking a live key, never tightened, so where the two readings are close the strict
//     one is the reversible one.
//  2. **No parallel logic.** Every verb delegates to the same `NotificationWebhookService` method
//     the session controller calls, so the SSRF guard on the endpoint, the keep-on-omit rule for
//     each field and the per-workspace endpoint cap hold identically whichever surface
//     writes. A `ValidationError` from the URL guard propagates to `handleError` rather than being
//     re-mapped here, so the refusal keeps its `details`.
//  3. **The secret stays write-only.** `put` accepts one and `get` reports `hasSecret`; nothing
//     reads it back. An `admin` key can rotate the signing secret, and cannot learn the stored
//     one, which is what keeps this surface from turning a key compromise into the ability to
//     FORGE deliveries that a receiver would verify.
//
// Auth failures go through `refuse` rather than a thrown `DomainError`, like the sibling public
// controllers: on this surface a refusal is DATA the contract handler returns, so the handler
// stays typed against its declared response schemas (see `publicApiAuth.ts`).

/** Resolve the webhook service; absent on a deployment that sealed no `ENCRYPTION_KEY`. */
function webhooksOf<E extends AppEnv>(c: Context<E>): NotificationWebhookService | null {
  return c.get('container').notificationWebhooks ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Notification webhooks are not configured' } },
    503,
  )

export function publicNotificationWebhookController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // "Am I already wired up?", the call an integration makes at startup. `{ webhook: null }` is a
  // real answer, not a 404: the workspace exists and simply has no endpoint registered.
  buildHonoRoute(app, getPublicNotificationWebhookContract, async (c) => {
    const gate = await authorize(c, getPublicNotificationWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    return c.json(
      { webhook: await webhooks.get(gate.auth.workspaceId, DEFAULT_NOTIFICATION_WEBHOOK_ID) },
      200,
    )
  })

  // Register, edit or rotate. A field the body omits KEEPS its stored value (the service's rule,
  // not this controller's), so an integration that only wants to add `runEvents` sends that one
  // field rather than restating an endpoint and secret it never meant to touch.
  buildHonoRoute(app, putPublicNotificationWebhookContract, async (c) => {
    const gate = await authorize(c, putPublicNotificationWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    const saved = await webhooks.put(
      gate.auth.workspaceId,
      DEFAULT_NOTIFICATION_WEBHOOK_ID,
      c.req.valid('json'),
    )
    return c.json(saved, 200)
  })

  // Deregister. Idempotent, so a teardown script need not first ask whether anything is there.
  buildHonoRoute(app, deletePublicNotificationWebhookContract, async (c) => {
    const gate = await authorize(c, deletePublicNotificationWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    await webhooks.remove(gate.auth.workspaceId, DEFAULT_NOTIFICATION_WEBHOOK_ID)
    return c.body(null, 204)
  })

  // ---- the collection: several named endpoints, one per integration ----
  //
  // Every one of these is the corresponding singular route with the id supplied instead of
  // defaulted. That is the whole difference, deliberately: the enrolment rules a caller has to
  // reason about (keep-on-omit, the write-only secret, the SSRF guard, `admin` scope) must not
  // depend on which of the two shapes it happened to call.

  buildHonoRoute(app, listPublicNotificationWebhooksContract, async (c) => {
    const gate = await authorize(c, listPublicNotificationWebhooksContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    return c.json({ webhooks: await webhooks.list(gate.auth.workspaceId) }, 200)
  })

  buildHonoRoute(app, getPublicNamedNotificationWebhookContract, async (c) => {
    const gate = await authorize(c, getPublicNamedNotificationWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    const webhook = await webhooks.get(gate.auth.workspaceId, c.req.valid('param').webhookId)
    return c.json({ webhook }, 200)
  })

  buildHonoRoute(app, putPublicNamedNotificationWebhookContract, async (c) => {
    const gate = await authorize(c, putPublicNamedNotificationWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    const saved = await webhooks.put(
      gate.auth.workspaceId,
      c.req.valid('param').webhookId,
      c.req.valid('json'),
    )
    return c.json(saved, 200)
  })

  buildHonoRoute(app, deletePublicNamedNotificationWebhookContract, async (c) => {
    const gate = await authorize(c, deletePublicNamedNotificationWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const webhooks = webhooksOf(c)
    if (!webhooks) return unavailable(c)
    await webhooks.remove(gate.auth.workspaceId, c.req.valid('param').webhookId)
    return c.body(null, 204)
  })

  return app
}
