import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  cloneRiskPolicySchema,
  createRiskPolicySchema,
  riskPolicyLibraryEntrySchema,
  riskPolicySuppressionSchema,
  updateRiskPolicySchema,
} from '../merge.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Risk policy route contracts. The CRUD four are mounted under BOTH
// `/workspaces/:workspaceId` and `/accounts/:accountId`, so the paths here are relative to
// whichever prefix the controller was mounted at and one contract serves both tiers. The
// inheritance routes below (clone, suppression) are workspace-only: an account has no tier above
// it to inherit from. See RiskPolicyController in @cat-factory/server.
// ---------------------------------------------------------------------------

const riskPolicyListSchema = v.array(riskPolicyLibraryEntrySchema)
const presetIdParams = singleStringParam('presetId')

/**
 * The board's visible library: its own policies plus the account policies it inherits, each
 * tagged with the tier that owns it. At the ACCOUNT mount it is that account's own rows, which
 * carry `tier: 'account'` for the same reason — a single response shape means the editor renders
 * one list at either scope and reads editability off the tier rather than off which URL it called.
 */
export const listRiskPoliciesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/risk-policies',
  responsesByStatusCode: { 200: riskPolicyListSchema, ...errorResponses },
})

export const createRiskPolicyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/risk-policies',
  requestBodySchema: createRiskPolicySchema,
  responsesByStatusCode: { 201: riskPolicyLibraryEntrySchema, ...errorResponses },
})

export const updateRiskPolicyContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}`,
  requestBodySchema: updateRiskPolicySchema,
  responsesByStatusCode: { 200: riskPolicyLibraryEntrySchema, ...errorResponses },
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
  responsesByStatusCode: { 200: riskPolicyLibraryEntrySchema, ...errorResponses },
})

// ---- inheritance (workspace mount only) -----------------------------------

/**
 * Copy an inherited ACCOUNT policy into this board's own tier, under a fresh id, so the board can
 * edit its numbers without an account admin (see {@link cloneRiskPolicySchema}).
 *
 * A POST creating a new row, so `201` — this is not an in-place conversion of the account policy,
 * which stays exactly where it was and keeps governing every other board.
 */
export const cloneRiskPolicyContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}/clone`,
  requestBodySchema: cloneRiskPolicySchema,
  responsesByStatusCode: { 201: riskPolicyLibraryEntrySchema, ...errorResponses },
})

/**
 * The SUPPRESSION sub-resource: opting a board out of an account policy it inherits, and back in.
 *
 * Its own sub-resource rather than a flag on the policy, because a suppression is a fact a board
 * asserts about a row it does not own — there is no policy of its own to patch. And it is
 * deliberately NOT `DELETE /risk-policies/:id`: that deletes the board's OWN policy, where this
 * destroys nothing and is reversible, which is exactly why the two cannot share a verb.
 */
export const suppressRiskPolicyContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}/suppression`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const restoreRiskPolicyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/risk-policies/${presetId}/suppression`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * What this board is currently hiding. The merged library cannot answer it — a hidden id is
 * precisely one that list no longer carries — so a surface offering suppression would otherwise
 * offer no way back.
 *
 * A SIBLING top-level resource rather than a literal `/risk-policies/suppressions` segment, for
 * the reason the foundational-service list is: a literal segment sharing a namespace with
 * `:presetId` is a collision waiting for the first single-segment by-id route, and nothing stops a
 * policy id from being the word `suppressions`.
 */
export const listRiskPolicySuppressionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/risk-policy-suppressions',
  responsesByStatusCode: { 200: v.array(riskPolicySuppressionSchema), ...errorResponses },
})
