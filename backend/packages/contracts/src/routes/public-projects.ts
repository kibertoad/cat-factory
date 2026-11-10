import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { startPublicTaskSchema } from '../public-api.js'
import {
  createPublicProjectSchema,
  createPublicProjectTaskSchema,
  projectDefinitionKeyParamsSchema,
  projectDefinitionVersionParamsSchema,
  projectKindParamsSchema,
  publicCredentialResumeSchema,
  publicProjectDefinitionListSchema,
  publicProjectDefinitionSchema,
  publicProjectKindDetailSchema,
  publicProjectKindListSchema,
  publicProjectListSchema,
  publicProjectOutcomeListQuerySchema,
  publicProjectOutcomeListSchema,
  publicProjectOutcomeSchema,
  publicProjectSchema,
  publicProjectServicesSchema,
  publicProjectTaskListSchema,
  publicProjectTaskSchema,
  publicProjectViewSchema,
  publishProjectDefinitionSchema,
} from '../public-projects.js'
import { errorResponses, singleStringParam, withMinScope, withPersonalUnlock } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public PROJECTS surface. Wire shapes and their reasoning live in
// `../public-projects.ts`; the account for an integrator is `backend/docs/public-api.md`.
//
// Scopes follow the task surface: reads are `read`, creating and linking are `write`, and
// starting or retrying a project task is `write` with the personal-unlock headers. Publishing a
// definition is `admin`: a definition declares the credentials a run sends to a third party and
// the targets it may send them to, which is configuration rather than work.
// ---------------------------------------------------------------------------

const projectIdParams = singleStringParam('projectId')
const kindParams = withObjectKeys(projectKindParamsSchema)
const definitionKeyParams = withObjectKeys(projectDefinitionKeyParamsSchema)
const definitionVersionParams = withObjectKeys(projectDefinitionVersionParamsSchema)
const projectTaskParams = withObjectKeys(v.object({ projectId: v.string(), taskId: v.string() }))
const runIdParams = singleStringParam('runId')
const outcomeParams = withObjectKeys(v.object({ projectId: v.string(), outcomeId: v.string() }))

/** The project kinds the deployment offers. */
export const listPublicProjectKindsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/project-kinds',
    responsesByStatusCode: { 200: publicProjectKindListSchema, ...errorResponses },
  }),
)

/** One project kind with the JSON Schemas of its spec, outcome body and view. */
export const getPublicProjectKindContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: kindParams,
    pathResolver: ({ kind }) => `/api/v1/project-kinds/${kind}`,
    responsesByStatusCode: { 200: publicProjectKindDetailSchema, ...errorResponses },
  }),
)

/** Every definition of one kind the key's account can pin: the deployment's, then its own. */
export const listPublicProjectDefinitionsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: kindParams,
    pathResolver: ({ kind }) => `/api/v1/project-kinds/${kind}/definitions`,
    responsesByStatusCode: { 200: publicProjectDefinitionListSchema, ...errorResponses },
  }),
)

/** Every version of one definition key, ascending. */
export const getPublicProjectDefinitionContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: definitionKeyParams,
    pathResolver: ({ kind, key }) => `/api/v1/project-kinds/${kind}/definitions/${key}`,
    responsesByStatusCode: { 200: publicProjectDefinitionListSchema, ...errorResponses },
  }),
)

/** Publish one immutable version of an account-owned definition. */
export const publishPublicProjectDefinitionContract = withMinScope(
  'admin',
  defineApiContract({
    method: 'put',
    requestPathParamsSchema: definitionVersionParams,
    pathResolver: ({ kind, key, version }) =>
      `/api/v1/project-kinds/${kind}/definitions/${key}/versions/${version}`,
    requestBodySchema: publishProjectDefinitionSchema,
    responsesByStatusCode: { 201: publicProjectDefinitionSchema, ...errorResponses },
  }),
)

/** The projects the key's workspace mounts. */
export const listPublicProjectsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/projects',
    responsesByStatusCode: { 200: publicProjectListSchema, ...errorResponses },
  }),
)

/** Create a project homed on the key's workspace. */
export const createPublicProjectContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    pathResolver: () => '/api/v1/projects',
    requestBodySchema: createPublicProjectSchema,
    responsesByStatusCode: { 201: publicProjectSchema, ...errorResponses },
  }),
)

export const getPublicProjectContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}`,
    responsesByStatusCode: { 200: publicProjectSchema, ...errorResponses },
  }),
)

/** Link services to a project. Already linked ones are kept. */
export const linkPublicProjectServicesContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/services`,
    requestBodySchema: publicProjectServicesSchema,
    responsesByStatusCode: { 200: publicProjectSchema, ...errorResponses },
  }),
)

/** Unlink services from a project. A service not linked is ignored. */
export const unlinkPublicProjectServicesContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/services/unlink`,
    requestBodySchema: publicProjectServicesSchema,
    responsesByStatusCode: { 200: publicProjectSchema, ...errorResponses },
  }),
)

/** Mount a project of the key's account onto the key's workspace. Idempotent. */
export const mountPublicProjectContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/mount`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: publicProjectSchema, ...errorResponses },
  }),
)

export const listPublicProjectTasksContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/tasks`,
    responsesByStatusCode: { 200: publicProjectTaskListSchema, ...errorResponses },
  }),
)

export const createPublicProjectTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/tasks`,
    requestBodySchema: createPublicProjectTaskSchema,
    responsesByStatusCode: { 201: publicProjectTaskSchema, ...errorResponses },
  }),
)

export const getPublicProjectTaskContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: projectTaskParams,
    pathResolver: ({ projectId, taskId }) => `/api/v1/projects/${projectId}/tasks/${taskId}`,
    responsesByStatusCode: { 200: publicProjectTaskSchema, ...errorResponses },
  }),
)

export const startPublicProjectTaskContract = withPersonalUnlock(
  withMinScope(
    'write',
    defineApiContract({
      method: 'post',
      requestPathParamsSchema: projectTaskParams,
      pathResolver: ({ projectId, taskId }) =>
        `/api/v1/projects/${projectId}/tasks/${taskId}/start`,
      requestBodySchema: startPublicTaskSchema,
      responsesByStatusCode: { 202: publicProjectTaskSchema, ...errorResponses },
    }),
  ),
)

export const stopPublicProjectTaskContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: projectTaskParams,
    pathResolver: ({ projectId, taskId }) => `/api/v1/projects/${projectId}/tasks/${taskId}/stop`,
    requestBodySchema: ContractNoBody,
    responsesByStatusCode: { 200: publicProjectTaskSchema, ...errorResponses },
  }),
)

export const retryPublicProjectTaskContract = withPersonalUnlock(
  withMinScope(
    'write',
    defineApiContract({
      method: 'post',
      requestPathParamsSchema: projectTaskParams,
      pathResolver: ({ projectId, taskId }) =>
        `/api/v1/projects/${projectId}/tasks/${taskId}/retry`,
      requestBodySchema: ContractNoBody,
      responsesByStatusCode: { 202: publicProjectTaskSchema, ...errorResponses },
    }),
  ),
)

/** The project's outcomes without their bodies, `seq` ascending. */
export const listPublicProjectOutcomesContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: projectIdParams,
    requestQuerySchema: publicProjectOutcomeListQuerySchema,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/outcomes`,
    responsesByStatusCode: { 200: publicProjectOutcomeListSchema, ...errorResponses },
  }),
)

/** One outcome with its body. */
export const getPublicProjectOutcomeContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: outcomeParams,
    pathResolver: ({ projectId, outcomeId }) =>
      `/api/v1/projects/${projectId}/outcomes/${outcomeId}`,
    responsesByStatusCode: { 200: publicProjectOutcomeSchema, ...errorResponses },
  }),
)

/** The project's current state as its kind reads every outcome. */
export const getPublicProjectViewContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: projectIdParams,
    pathResolver: ({ projectId }) => `/api/v1/projects/${projectId}/view`,
    responsesByStatusCode: { 200: publicProjectViewSchema, ...errorResponses },
  }),
)

/**
 * Resume a run parked on a missing capability credential, once the credential is stored. Refused
 * with `capability_credential_still_missing` while the key does not resolve. A lapsed personal
 * credential is renewed in the app by the run's initiator (`credential_wait_personal_in_app`).
 * `decide` scope: it answers a park.
 */
export const resumePublicRunCredentialContract = withPersonalUnlock(
  withMinScope(
    'decide',
    defineApiContract({
      method: 'post',
      requestPathParamsSchema: runIdParams,
      pathResolver: ({ runId }) => `/api/v1/runs/${runId}/credential/resume`,
      requestBodySchema: ContractNoBody,
      responsesByStatusCode: { 200: publicCredentialResumeSchema, ...errorResponses },
    }),
  ),
)
