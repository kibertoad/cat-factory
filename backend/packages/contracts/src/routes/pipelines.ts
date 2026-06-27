import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { pipelineSchema } from '../entities.js'
import {
  clonePipelineSchema,
  createPipelineSchema,
  organizePipelineSchema,
  updatePipelineSchema,
} from '../requests.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Pipeline palette CRUD route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See PipelineController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const pipelineListSchema = v.array(pipelineSchema)
const pipelineIdParams = withObjectKeys(v.object({ pipelineId: v.string() }))

export const listPipelinesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/pipelines',
  responsesByStatusCode: { 200: pipelineListSchema, ...errorResponses },
})

export const createPipelineContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/pipelines',
  requestBodySchema: createPipelineSchema,
  responsesByStatusCode: { 201: pipelineSchema, ...errorResponses },
})

export const clonePipelineContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: pipelineIdParams,
  pathResolver: ({ pipelineId }) => `/pipelines/${pipelineId}/clone`,
  requestBodySchema: clonePipelineSchema,
  responsesByStatusCode: { 201: pipelineSchema, ...errorResponses },
})

export const reseedPipelineContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: pipelineIdParams,
  pathResolver: ({ pipelineId }) => `/pipelines/${pipelineId}/reseed`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: pipelineSchema, ...errorResponses },
})

export const updatePipelineContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: pipelineIdParams,
  pathResolver: ({ pipelineId }) => `/pipelines/${pipelineId}`,
  requestBodySchema: updatePipelineSchema,
  responsesByStatusCode: { 200: pipelineSchema, ...errorResponses },
})

export const organizePipelineContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: pipelineIdParams,
  pathResolver: ({ pipelineId }) => `/pipelines/${pipelineId}/organize`,
  requestBodySchema: organizePipelineSchema,
  responsesByStatusCode: { 200: pipelineSchema, ...errorResponses },
})

export const deletePipelineContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: pipelineIdParams,
  pathResolver: ({ pipelineId }) => `/pipelines/${pipelineId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
