import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { createRiskPolicySchema, riskPolicySchema, updateRiskPolicySchema } from '../merge.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Merge threshold preset route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See RiskPolicyController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const riskPolicyListSchema = v.array(riskPolicySchema)
const presetIdParams = singleStringParam('presetId')

export const listRiskPoliciesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/risk-policies',
  responsesByStatusCode: { 200: riskPolicyListSchema, ...errorResponses },
})

export const createRiskPolicyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/risk-policies',
  requestBodySchema: createRiskPolicySchema,
  responsesByStatusCode: { 201: riskPolicySchema, ...errorResponses },
})

export const updateRiskPolicyContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}`,
  requestBodySchema: updateRiskPolicySchema,
  responsesByStatusCode: { 200: riskPolicySchema, ...errorResponses },
})

export const deleteRiskPolicyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * Reseed a built-in merge preset from the current catalog (`seedRiskPolicies()`): adopt an
 * updated definition, repair a drifted one, or materialise a NEW built-in that appeared after
 * the workspace was created. The `presetId` is the catalog id (e.g. `mp_balanced`). Rejects an
 * id not in the catalog (a custom preset — delete it instead).
 */
export const reseedRiskPolicyContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}/reseed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: riskPolicySchema, ...errorResponses },
})
