import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  createPublicApiKeySchema,
  createdPublicApiKeySchema,
  publicApiKeyListResultSchema,
} from '../public-api-keys.js'
import {
  createInitiativeJobSchema,
  createPublicTaskSchema,
  initiativeAcceptedSchema,
  publicJobSchema,
  publicPipelineListSchema,
  publicRunSchema,
  publicServiceListSchema,
  publicTaskListSchema,
  publicTaskSchema,
  startPublicTaskSchema,
  updatePublicTaskSchema,
} from '../public-api.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Public-API route contracts. Two surfaces:
//
//  1. Key management — session-authed, mounted under `/workspaces/:workspaceId`
//     (so paths are relative). A workspace owner mints/lists/revokes the keys an
//     external system will present. Note the path is `/public-api-keys` — the bare
//     `/api-keys` is the direct-provider (outbound) key pool.
//
//  2. The external surface — `/api/v1/*`, authenticated in-controller by the
//     public-API key (not the session gate), scoped to the key's workspace.
// ---------------------------------------------------------------------------

const idParams = singleStringParam('id')
const serviceIdParams = singleStringParam('serviceId')
const taskIdParams = singleStringParam('taskId')

// ---- key management (relative to `/workspaces/:workspaceId`) ---------------

export const listPublicApiKeysContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/public-api-keys',
  responsesByStatusCode: { 200: publicApiKeyListResultSchema, ...errorResponses },
})

export const createPublicApiKeyContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/public-api-keys',
  requestBodySchema: createPublicApiKeySchema,
  responsesByStatusCode: { 201: createdPublicApiKeySchema, ...errorResponses },
})

export const revokePublicApiKeyContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/public-api-keys/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- the external `/api/v1` surface (absolute paths, key-authenticated) ----

export const createInitiativeJobContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/api/v1/initiatives',
  requestBodySchema: createInitiativeJobSchema,
  responsesByStatusCode: { 202: initiativeAcceptedSchema, ...errorResponses },
})

export const getPublicJobContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: idParams,
  pathResolver: ({ id }) => `/api/v1/jobs/${id}`,
  responsesByStatusCode: { 200: publicJobSchema, ...errorResponses },
})

// ---- basic board workloads: services + tasks (key-authenticated) -----------

/** List the workspace's services (board service frames). */
export const listPublicServicesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/v1/services',
  responsesByStatusCode: { 200: publicServiceListSchema, ...errorResponses },
})

/** Create a task under a service. */
export const createPublicTaskContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}/tasks`,
  requestBodySchema: createPublicTaskSchema,
  responsesByStatusCode: { 201: publicTaskSchema, ...errorResponses },
})

/** List a service's tasks (the whole subtree — tasks under the frame and its modules). */
export const listPublicServiceTasksContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/api/v1/services/${serviceId}/tasks`,
  responsesByStatusCode: { 200: publicTaskListSchema, ...errorResponses },
})

/** Get a task's status. */
export const getPublicTaskContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: taskIdParams,
  pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}`,
  responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
})

/** Start (run) a task. */
export const startPublicTaskContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: taskIdParams,
  pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/start`,
  requestBodySchema: startPublicTaskSchema,
  responsesByStatusCode: { 202: publicTaskSchema, ...errorResponses },
})

/** Edit a task's title/description (pre-start edits). */
export const updatePublicTaskContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: taskIdParams,
  pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}`,
  requestBodySchema: updatePublicTaskSchema,
  responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
})

/** Stop a task's in-flight run (records a `cancelled` terminal state, leaving it retryable). */
export const stopPublicTaskContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: taskIdParams,
  pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/stop`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: publicTaskSchema, ...errorResponses },
})

/** Retry a task's failed run. */
export const retryPublicTaskContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: taskIdParams,
  pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/retry`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 202: publicTaskSchema, ...errorResponses },
})

/** Read a task's rich run projection (per-step status, subtasks, failure, PR branch). */
export const getPublicRunContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: taskIdParams,
  pathResolver: ({ taskId }) => `/api/v1/tasks/${taskId}/run`,
  responsesByStatusCode: { 200: publicRunSchema, ...errorResponses },
})

// ---- pipeline discovery (key-authenticated) --------------------------------

/** List the workspace's pipelines (id/name/steps + a headless-startable flag). */
export const listPublicPipelinesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/api/v1/pipelines',
  responsesByStatusCode: { 200: publicPipelineListSchema, ...errorResponses },
})
