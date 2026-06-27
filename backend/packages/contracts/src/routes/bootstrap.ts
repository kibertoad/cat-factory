import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  bootstrapJobSchema,
  bootstrapRepoSchema,
  createReferenceArchitectureSchema,
  referenceArchitectureSchema,
  updateReferenceArchitectureSchema,
} from '../bootstrap.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Repo-bootstrap route contracts. Mounted under `/workspaces/:workspaceId`, so
// the paths here are relative to that prefix. See BootstrapController.
// ---------------------------------------------------------------------------

const referenceArchitectureListSchema = v.array(referenceArchitectureSchema)
const bootstrapJobListSchema = v.array(bootstrapJobSchema)
const referenceArchitectureIdParams = singleStringParam('id')
const bootstrapJobIdParams = singleStringParam('id')

// ---- reference architectures ----------------------------------------------

export const listReferenceArchitecturesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/bootstrap/reference-architectures',
  responsesByStatusCode: { 200: referenceArchitectureListSchema, ...errorResponses },
})

export const createReferenceArchitectureContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/bootstrap/reference-architectures',
  requestBodySchema: createReferenceArchitectureSchema,
  responsesByStatusCode: { 201: referenceArchitectureSchema, ...errorResponses },
})

export const updateReferenceArchitectureContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: referenceArchitectureIdParams,
  pathResolver: ({ id }) => `/bootstrap/reference-architectures/${id}`,
  requestBodySchema: updateReferenceArchitectureSchema,
  responsesByStatusCode: { 200: referenceArchitectureSchema, ...errorResponses },
})

export const deleteReferenceArchitectureContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: referenceArchitectureIdParams,
  pathResolver: ({ id }) => `/bootstrap/reference-architectures/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- bootstrap jobs -------------------------------------------------------

export const listBootstrapJobsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/bootstrap/jobs',
  responsesByStatusCode: { 200: bootstrapJobListSchema, ...errorResponses },
})

export const getBootstrapJobContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: bootstrapJobIdParams,
  pathResolver: ({ id }) => `/bootstrap/jobs/${id}`,
  responsesByStatusCode: { 200: bootstrapJobSchema, ...errorResponses },
})

export const startBootstrapJobContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/bootstrap/jobs',
  requestBodySchema: bootstrapRepoSchema,
  responsesByStatusCode: { 201: bootstrapJobSchema, ...errorResponses },
})
