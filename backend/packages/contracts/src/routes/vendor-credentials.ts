import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  addVendorCredentialSchema,
  vendorCredentialListSchema,
  vendorCredentialSchema,
} from '../vendor-credentials.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Vendor-credential (subscription token pool) route contracts. Tokens are
// write-only — only metadata + rolling-window usage is ever returned. Mounted
// under `/workspaces/:workspaceId`, so the paths here are relative to that
// prefix. See VendorCredentialController.
// ---------------------------------------------------------------------------

const credentialIdParams = singleStringParam('id')

// Response wrapper that exists only inline in the controller today.
const vendorCredentialsViewSchema = v.object({
  credentials: vendorCredentialListSchema,
})

export const listVendorCredentialsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/vendor-credentials',
  responsesByStatusCode: { 200: vendorCredentialsViewSchema, ...errorResponses },
})

export const addVendorCredentialContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/vendor-credentials',
  requestBodySchema: addVendorCredentialSchema,
  responsesByStatusCode: { 201: vendorCredentialSchema, ...errorResponses },
})

export const removeVendorCredentialContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: credentialIdParams,
  pathResolver: ({ id }) => `/vendor-credentials/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
