import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  notificationWebhookSchema,
  putNotificationWebhookSchema,
} from '../notification-webhooks.js'
import { errorResponses } from './_shared.js'

// Management routes for a workspace's OUTBOUND notification webhook — session-authed and mounted
// under `/workspaces/:workspaceId` (so paths are relative), like the tracker/Slack settings. The
// endpoint they configure is consumed by `WebhookNotificationChannel`, not by these routes.
//
// These are writes to an integration's configuration, so they sit behind the
// `integrations.manage` workspace permission like every other admin controller.

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
