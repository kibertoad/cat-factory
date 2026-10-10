import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { actNotificationSchema, notificationSchema } from '../notifications.js'
import {
  notificationSettingsSchema,
  updateNotificationSettingsSchema,
} from '../notification-routing.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Notification inbox route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix (the frontend supplies it via
// `pathPrefix`, the backend via the controller's mount point).
// ---------------------------------------------------------------------------

const notificationListSchema = v.array(notificationSchema)
const notificationIdParams = singleStringParam('notificationId')

export const listNotificationsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/notifications',
  responsesByStatusCode: { 200: notificationListSchema, ...errorResponses },
})

export const actNotificationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: notificationIdParams,
  pathResolver: ({ notificationId }) => `/notifications/${notificationId}/act`,
  // All-optional body: `{}` is the historical no-body act. A merge card can carry the
  // reviewer-effort tag here so confirming the merge and tagging it is ONE request.
  requestBodySchema: actNotificationSchema,
  responsesByStatusCode: { 200: notificationSchema, ...errorResponses },
})

export const dismissNotificationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: notificationIdParams,
  pathResolver: ({ notificationId }) => `/notifications/${notificationId}/dismiss`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: notificationSchema, ...errorResponses },
})

// ---- the notification manager (per-workspace channel routing) --------------
// Which types this board delivers on which channel. Readable by any member (the settings
// surface renders the resolved state); the write is admin-tier, gated at the controller.

export const getNotificationSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/notification-settings',
  responsesByStatusCode: { 200: notificationSettingsSchema, ...errorResponses },
})

export const updateNotificationSettingsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/notification-settings',
  requestBodySchema: updateNotificationSettingsSchema,
  responsesByStatusCode: { 200: notificationSettingsSchema, ...errorResponses },
})
