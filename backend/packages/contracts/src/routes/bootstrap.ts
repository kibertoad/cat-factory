import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  bootstrapJobSchema,
  bootstrapRepoSchema,
  createReferenceArchitectureSchema,
  referenceArchitectureSchema,
  updateReferenceArchitectureSchema,
} from '../bootstrap.js'
import { adoptionReviewSchema } from '../monorepo-adoption.js'
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

/**
 * Settle a parked monorepo bootstrap's adoption plan and resume the run.
 *
 * The one human decision the flow is built around: which of the reference template's answers
 * the new service keeps and which it takes from the monorepo it is landing in. Answering every
 * decision is required (the service refuses a partial review rather than defaulting the gaps to
 * the model's recommendation), and the run only writes code after this returns.
 *
 * 409 `bootstrap_not_awaiting_review` when the run is not parked; 422 when the choices do not
 * cover the stored plan.
 */
export const submitAdoptionReviewContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: bootstrapJobIdParams,
  pathResolver: ({ id }) => `/bootstrap/jobs/${id}/adoption-review`,
  requestBodySchema: adoptionReviewSchema,
  responsesByStatusCode: { 200: bootstrapJobSchema, ...errorResponses },
})
