import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  createModelPresetSchema,
  modelPresetSchema,
  updateModelPresetSchema,
} from '../model-presets.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Model preset route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. See ModelPresetController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const modelPresetListSchema = v.array(modelPresetSchema)
const presetIdParams = withObjectKeys(v.object({ presetId: v.string() }))

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
