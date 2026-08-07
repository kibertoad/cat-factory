import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  notificationWebhookSchema,
  publicNotificationWebhookListSchema,
  publicNotificationWebhookSchema,
  putNotificationWebhookSchema,
} from '../notification-webhooks.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// Management routes for a workspace's OUTBOUND notification webhooks, on TWO surfaces:
//
//  1. Session-authed, mounted under `/workspaces/:workspaceId` (so paths are relative), like the
//     tracker/Slack settings. These are writes to an integration's configuration, so they sit
//     behind the `integrations.manage` workspace permission like every other admin controller.
//  2. `/api/v1/notification-webhook`, on absolute paths, authenticated in-controller by an
//     `admin`-scope public-API key. Same three verbs against the same service.
//
// The endpoints they configure are consumed by `WebhookNotificationChannel` and the run-lifecycle
// / platform-alert sinks beside it, not by these routes.
//
// The second surface exists because the FIRST one made the push channel unreachable to exactly
// the caller it was built for. A deployment whose operator is headless has no browser session, so
// the receiver that run-lifecycle push exists to feed could only be registered by a human clicking
// through an app the feature deliberately does not need. Both surfaces are thin delegates over
// `NotificationWebhookService` (same URL guard, same write-only secret, same per-endpoint rules),
// so neither can admit an endpoint the other would reject.
//
// Each surface comes in two shapes. The SINGULAR routes (`…/notification-webhook`) address the one
// id `default`; the COLLECTION (`…/notification-webhooks[/:webhookId]`) addresses any of them. The
// singular pair is not a legacy alias kept alive out of politeness: it is the whole surface a
// deployment with one receiver ever needs, and collapsing it into the collection would have made
// every existing consumer move for a capability it does not use.

/** The workspace's default webhook, or null when none is set. Never returns the secret. */
export const getNotificationWebhookContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/notification-webhook',
  responsesByStatusCode: {
    200: v.nullable(notificationWebhookSchema),
    ...errorResponses,
  },
})

/** Register or update the webhook. Omitting `secret` keeps the stored signing secret. */
export const putNotificationWebhookContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/notification-webhook',
  requestBodySchema: putNotificationWebhookSchema,
  responsesByStatusCode: { 200: notificationWebhookSchema, ...errorResponses },
})

/** Remove the webhook (deliveries stop). Idempotent. */
export const deleteNotificationWebhookContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/notification-webhook',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- the session surface's COLLECTION (every named endpoint) ----

/** Every endpoint the workspace has registered, ordered by id. Never returns a secret. */
export const listNotificationWebhooksContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/notification-webhooks',
  responsesByStatusCode: {
    200: publicNotificationWebhookListSchema,
    ...errorResponses,
  },
})

/** One named endpoint, or null when nothing is registered under that id. */
export const getNamedNotificationWebhookContract = defineApiContract({
  method: 'get',
  pathResolver: (p: { webhookId: string }) => `/notification-webhooks/${p.webhookId}`,
  requestPathParamsSchema: singleStringParam('webhookId'),
  responsesByStatusCode: { 200: publicNotificationWebhookSchema, ...errorResponses },
})

/** Register or update one named endpoint. Keep-on-omit in every field, like the singular route. */
export const putNamedNotificationWebhookContract = defineApiContract({
  method: 'put',
  pathResolver: (p: { webhookId: string }) => `/notification-webhooks/${p.webhookId}`,
  requestPathParamsSchema: singleStringParam('webhookId'),
  requestBodySchema: putNotificationWebhookSchema,
  responsesByStatusCode: { 200: notificationWebhookSchema, ...errorResponses },
})

/** Remove one named endpoint (its deliveries stop; its siblings are untouched). Idempotent. */
export const deleteNamedNotificationWebhookContract = defineApiContract({
  method: 'delete',
  pathResolver: (p: { webhookId: string }) => `/notification-webhooks/${p.webhookId}`,
  requestPathParamsSchema: singleStringParam('webhookId'),
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- the external `/api/v1` surface (absolute paths, key-authenticated) ----

/**
 * Read the workspace's registered endpoint. `{ webhook: null }` when none is registered: a real
 * answer rather than a 404, so a caller's startup self-check ("am I already wired up?") reads one
 * response shape instead of branching on a status the surface also uses for a bad path.
 */
export const getPublicNotificationWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/notification-webhook',
    responsesByStatusCode: { 200: publicNotificationWebhookSchema, ...errorResponses },
  }),
)

/**
 * Register or update the endpoint. Returns the stored projection directly (not the `webhook`
 * wrapper the read uses): a successful write always has an endpoint to describe, so wrapping it
 * would hand every client a null to check that cannot occur.
 *
 * `secret` is write-only on this surface exactly as it is on the session one: supplied here,
 * never returned by the read. An `admin` key can therefore ROTATE the signing secret but can
 * never exfiltrate the one already stored.
 */
export const putPublicNotificationWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'put',
    pathResolver: () => '/api/v1/notification-webhook',
    requestBodySchema: putNotificationWebhookSchema,
    responsesByStatusCode: { 200: notificationWebhookSchema, ...errorResponses },
  }),
)

/** Remove the endpoint (deliveries stop). Idempotent: 204 whether or not one was registered. */
export const deletePublicNotificationWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'delete',
    pathResolver: () => '/api/v1/notification-webhook',
    responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
  }),
)

// ---- the public COLLECTION: several named endpoints per workspace ----
//
// The singular resource above is ONE endpoint per workspace, which made a second integration's
// enrolment a hostile act: registering it stole the slot from whatever was already there, and the
// only way to notice was that the previous receiver went quiet. The collection is the additive fix
// — the singular routes keep working and now project onto the `default` id — and it is what lets a
// credential-holding front-end (a Cloudflare OS gatekeeper) enroll its own receiver, with its own
// signing secret and its own event filters, beside a deployment's existing CI hook.

/**
 * Every endpoint the workspace has registered. Bounded by the write path
 * (`MAX_NOTIFICATION_WEBHOOKS_PER_WORKSPACE`) rather than by a cursor: see the schema.
 */
export const listPublicNotificationWebhooksContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/notification-webhooks',
    responsesByStatusCode: { 200: publicNotificationWebhookListSchema, ...errorResponses },
  }),
)

/**
 * Read one named endpoint. `{ webhook: null }` when nothing is registered under that id, for the
 * same reason the singular read answers that way: this is a startup self-check, and an id a caller
 * chose for itself is not a resource it can mistype into somebody else's.
 */
export const getPublicNamedNotificationWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: singleStringParam('webhookId'),
    pathResolver: ({ webhookId }) => `/api/v1/notification-webhooks/${webhookId}`,
    responsesByStatusCode: { 200: publicNotificationWebhookSchema, ...errorResponses },
  }),
)

/**
 * Register or update one named endpoint under a CALLER-CHOSEN id, with the same keep-on-omit rule
 * and the same write-only secret as the singular route. Creating a new id past the per-workspace
 * cap is refused with `reason: 'webhook_limit_reached'`; an id that is not a lowercase slug with
 * `reason: 'invalid_webhook_id'`.
 */
export const putPublicNamedNotificationWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'put',
    requestPathParamsSchema: singleStringParam('webhookId'),
    pathResolver: ({ webhookId }) => `/api/v1/notification-webhooks/${webhookId}`,
    requestBodySchema: putNotificationWebhookSchema,
    responsesByStatusCode: { 200: notificationWebhookSchema, ...errorResponses },
  }),
)

/**
 * Remove one named endpoint. Idempotent, and scoped to the id alone: a caller tearing its own
 * receiver down can never take a sibling integration's registration with it.
 */
export const deletePublicNamedNotificationWebhookContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'delete',
    requestPathParamsSchema: singleStringParam('webhookId'),
    pathResolver: ({ webhookId }) => `/api/v1/notification-webhooks/${webhookId}`,
    responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
  }),
)
