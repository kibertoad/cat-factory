import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  createModelPresetSchema,
  modelPresetSchema,
  updateModelPresetSchema,
} from '../model-presets.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Model preset route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. See ModelPresetController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const modelPresetListSchema = v.array(modelPresetSchema)
const presetIdParams = singleStringParam('presetId')

export const listModelPresetsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/model-presets',
  responsesByStatusCode: { 200: modelPresetListSchema, ...errorResponses },
})

export const createModelPresetContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/model-presets',
  requestBodySchema: createModelPresetSchema,
  responsesByStatusCode: { 201: modelPresetSchema, ...errorResponses },
})

export const updateModelPresetContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/model-presets/${presetId}`,
  requestBodySchema: updateModelPresetSchema,
  responsesByStatusCode: { 200: modelPresetSchema, ...errorResponses },
})

export const deleteModelPresetContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/model-presets/${presetId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * Reseed a built-in model preset from the current catalog (`seedModelPresets()`): adopt an
 * updated definition, repair a drifted one, or materialise a NEW built-in that appeared after
 * the workspace was created. The `presetId` is the catalog id (e.g. `mdp_kimi`). Rejects an id
 * not in the catalog (a custom preset — delete it instead).
 */
export const reseedModelPresetContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: presetIdParams,
  pathResolver: ({ presetId }) => `/model-presets/${presetId}/reseed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: modelPresetSchema, ...errorResponses },
})
