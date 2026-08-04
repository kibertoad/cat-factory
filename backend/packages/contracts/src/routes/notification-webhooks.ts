import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  notificationWebhookSchema,
  publicNotificationWebhookSchema,
  putNotificationWebhookSchema,
} from '../notification-webhooks.js'
import { errorResponses } from './_shared.js'

// Management routes for a workspace's OUTBOUND notification webhook, on TWO surfaces:
//
//  1. Session-authed, mounted under `/workspaces/:workspaceId` (so paths are relative), like the
//     tracker/Slack settings. These are writes to an integration's configuration, so they sit
//     behind the `integrations.manage` workspace permission like every other admin controller.
//  2. `/api/v1/notification-webhook`, on absolute paths, authenticated in-controller by an
//     `admin`-scope public-API key. Same three verbs against the same service.
//
// The endpoint they configure is consumed by `WebhookNotificationChannel` and the run-lifecycle /
// platform-alert sinks beside it, not by these routes.
//
// The second surface exists because the FIRST one made the push channel unreachable to exactly
// the caller it was built for. A deployment whose operator is headless has no browser session, so
// the receiver that run-lifecycle push exists to feed could only be registered by a human clicking
// through an app the feature deliberately does not need. Both surfaces are thin delegates over
// `NotificationWebhookService` (same URL guard, same write-only secret, same
// one-row-per-workspace rule), so neither can admit an endpoint the other would reject.

/** The workspace's registered webhook, or null when none is set. Never returns the secret. */
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

// ---- the external `/api/v1` surface (absolute paths, key-authenticated) ----

/**
 * Read the workspace's registered endpoint. `{ webhook: null }` when none is registered: a real
 * answer rather than a 404, so a caller's startup self-check ("am I already wired up?") reads one
 * response shape instead of branching on a status the surface also uses for a bad path.
 */
export const getPublicNotificationWebhookContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/v1/notification-webhook',
  responsesByStatusCode: { 200: publicNotificationWebhookSchema, ...errorResponses },
})

/**
 * Register or update the endpoint. Returns the stored projection directly (not the `webhook`
 * wrapper the read uses): a successful write always has an endpoint to describe, so wrapping it
 * would hand every client a null to check that cannot occur.
 *
 * `secret` is write-only on this surface exactly as it is on the session one: supplied here,
 * never returned by the read. An `admin` key can therefore ROTATE the signing secret but can
 * never exfiltrate the one already stored.
 */
export const putPublicNotificationWebhookContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/api/v1/notification-webhook',
  requestBodySchema: putNotificationWebhookSchema,
  responsesByStatusCode: { 200: notificationWebhookSchema, ...errorResponses },
})

/** Remove the endpoint (deliveries stop). Idempotent: 204 whether or not one was registered. */
export const deletePublicNotificationWebhookContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/api/v1/notification-webhook',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
