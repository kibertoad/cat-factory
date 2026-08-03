import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  capabilityCredentialKeySchema,
  capabilityCredentialsViewSchema,
  setCapabilityCredentialSchema,
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

// A per-KEY write beside the whole-set PUT. The set-replacing PUT is the API caller's operation
// (declare the whole set in one call); a UI filling in a CHECKLIST edits one key at a time and
// cannot use it, because it never received the other values: re-sending the set would mean
// re-typing every secret, and sending only the edited key would delete the rest. The key is
// held to the credential-key schema here, so a reserved name is refused before the store sees it.
export const setCapabilityCredentialContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: withObjectKeys(v.object({ key: capabilityCredentialKeySchema })),
  pathResolver: ({ key }) => `/capability-credentials/${key}`,
  requestBodySchema: setCapabilityCredentialSchema,
  responsesByStatusCode: { 200: capabilityCredentialsViewSchema, ...errorResponses },
})

// A per-KEY delete for the same reason, and the operation that makes an ORPHANED credential
// removable at all: removing one stored key must not require re-sending every other value.
export const deleteCapabilityCredentialContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: keyParams,
  pathResolver: ({ key }) => `/capability-credentials/${key}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
