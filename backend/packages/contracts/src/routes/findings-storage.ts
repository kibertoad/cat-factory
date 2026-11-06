import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { findingsStoragePolicySchema } from '../research.js'
import {
  findingsStoragePolicyViewSchema,
  setAccountFindingsStoragePolicyInputSchema,
  setFindingsStoragePolicyInputSchema,
} from '../research-view.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Findings-storage policy route contracts. The board routes mount under `/workspaces/:workspaceId`
// and set the board's own tier or a project it mounts; the account route mounts under
// `/accounts/:accountId`. See FindingsStoragePolicyController in @cat-factory/server.
// ---------------------------------------------------------------------------

export const getFindingsStoragePolicyContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/findings-storage-policy',
  requestQuerySchema: v.object({ projectId: v.optional(v.string()) }),
  responsesByStatusCode: { 200: findingsStoragePolicyViewSchema, ...errorResponses },
})

export const setFindingsStoragePolicyContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/findings-storage-policy',
  requestBodySchema: setFindingsStoragePolicyInputSchema,
  responsesByStatusCode: { 200: findingsStoragePolicyViewSchema, ...errorResponses },
})

const accountPolicySchema = v.object({ policy: v.nullable(findingsStoragePolicySchema) })

export const getAccountFindingsStoragePolicyContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/findings-storage-policy',
  responsesByStatusCode: { 200: accountPolicySchema, ...errorResponses },
})

export const setAccountFindingsStoragePolicyContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/findings-storage-policy',
  requestBodySchema: setAccountFindingsStoragePolicyInputSchema,
  responsesByStatusCode: { 200: accountPolicySchema, ...errorResponses },
})
