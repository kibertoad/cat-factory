import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  capabilityCredentialsViewSchema,
  upsertCapabilityCredentialsSchema,
} from '../capability-credentials.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace CAPABILITY CREDENTIAL route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
//
// Values are write-only (never read back); the view returns which credentials this deployment's
// registered capabilities DECLARE, which of them this workspace has stored, and which stored keys
// nothing declares any more. See CapabilityCredentialsController.
// ---------------------------------------------------------------------------

const keyParams = singleStringParam('key')

export const getCapabilityCredentialsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/capability-credentials',
  responsesByStatusCode: { 200: capabilityCredentialsViewSchema, ...errorResponses },
})

export const setCapabilityCredentialsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/capability-credentials',
  requestBodySchema: upsertCapabilityCredentialsSchema,
  responsesByStatusCode: { 200: capabilityCredentialsViewSchema, ...errorResponses },
})

// A per-KEY delete beside the whole-set PUT, because the two are different operations for an
// operator: the PUT replaces the set (what a form submit does), while removing one orphaned
// credential must not require re-sending every other value — which the client cannot do, since
// it never received them.
export const deleteCapabilityCredentialContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: keyParams,
  pathResolver: ({ key }) => `/capability-credentials/${key}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
