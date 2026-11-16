import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { outcomeStoragePolicySchema } from '../project-outcomes.js'
import {
  outcomeStoragePolicyViewSchema,
  setAccountOutcomeStoragePolicyInputSchema,
  setOutcomeStoragePolicyInputSchema,
} from '../project-view.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Outcome-storage policy route contracts. The board routes mount under `/workspaces/:workspaceId`
// and set the board's own tier or a project it mounts; the account route mounts under
// `/accounts/:accountId`. See OutcomeStoragePolicyController in @cat-factory/server.
// ---------------------------------------------------------------------------

export const getOutcomeStoragePolicyContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/outcome-storage-policy',
  requestQuerySchema: v.object({ projectId: v.optional(v.string()) }),
  responsesByStatusCode: { 200: outcomeStoragePolicyViewSchema, ...errorResponses },
})

export const setOutcomeStoragePolicyContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/outcome-storage-policy',
  requestBodySchema: setOutcomeStoragePolicyInputSchema,
  responsesByStatusCode: { 200: outcomeStoragePolicyViewSchema, ...errorResponses },
})

const accountPolicySchema = v.object({ policy: v.nullable(outcomeStoragePolicySchema) })

export const getAccountOutcomeStoragePolicyContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/outcome-storage-policy',
  responsesByStatusCode: { 200: accountPolicySchema, ...errorResponses },
})

export const setAccountOutcomeStoragePolicyContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/outcome-storage-policy',
  requestBodySchema: setAccountOutcomeStoragePolicyInputSchema,
  responsesByStatusCode: { 200: accountPolicySchema, ...errorResponses },
})
