import { defineApiContract } from '@toad-contracts/valibot'
import { provisioningLogsResponseSchema } from '../provisioning-logs.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Provisioning event-log route contract. Mounted under `/workspaces/:workspaceId`,
// so the path here is relative to that prefix. The query params are read off the
// raw request in the controller (the contract describes path + method + response).
// ---------------------------------------------------------------------------

export const listProvisioningLogsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/provisioning-logs',
  responsesByStatusCode: { 200: provisioningLogsResponseSchema, ...errorResponses },
})
