import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  createMergePresetSchema,
  mergeThresholdPresetSchema,
  updateMergePresetSchema,
} from '../merge.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Merge threshold preset route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See MergePresetController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const mergePresetListSchema = v.array(mergeThresholdPresetSchema)
const presetIdParams = singleStringParam('presetId')

export const listMergePresetsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/merge-presets',
  responsesByStatusCode: { 200: mergePresetListSchema, ...errorResponses },
})

export const createMergePresetContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/merge-presets',
  requestBodySchema: createMergePresetSchema,
  responsesByStatusCode: { 201: mergeThresholdPresetSchema, ...errorResponses },
})

export const updateMergePresetContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/merge-presets/${presetId}`,
  requestBodySchema: updateMergePresetSchema,
  responsesByStatusCode: { 200: mergeThresholdPresetSchema, ...errorResponses },
})

export const deleteMergePresetContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/merge-presets/${presetId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * Reseed a built-in merge preset from the current catalog (`seedMergePresets()`): adopt an
 * updated definition, repair a drifted one, or materialise a NEW built-in that appeared after
 * the workspace was created. The `presetId` is the catalog id (e.g. `mp_balanced`). Rejects an
 * id not in the catalog (a custom preset — delete it instead).
 */
export const reseedMergePresetContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/merge-presets/${presetId}/reseed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: mergeThresholdPresetSchema, ...errorResponses },
})
