import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { notificationSchema } from '../notifications.js'
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
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: notificationSchema, ...errorResponses },
})

export const dismissNotificationContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: notificationIdParams,
  pathResolver: ({ notificationId }) => `/notifications/${notificationId}/dismiss`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: notificationSchema, ...errorResponses },
})
