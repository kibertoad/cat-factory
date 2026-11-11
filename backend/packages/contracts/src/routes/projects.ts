import { defineApiContract, noBodyResponse, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema } from '../entities.js'
import { pinnableProjectDefinitionSchema } from '../project-definitions.js'
import { projectBoardViewSchema, projectOutcomeDetailSchema } from '../project-view.js'
import {
  createProjectInputSchema,
  projectSchema,
  setProjectServicesInputSchema,
} from '../projects.js'
import {
  mountServiceInputSchema,
  updateMountInputSchema,
  workspaceMountSchema,
} from '../services.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Project route contracts. See ProjectController in @cat-factory/server. Mounted under
// `/workspaces/:workspaceId`, so the paths are relative to that prefix.
// ---------------------------------------------------------------------------

const projectIdParams = singleStringParam('projectId')

/** A created project, with the root block it owns as this board shows it. */
export const createdProjectSchema = v.object({
  project: projectSchema,
  rootBlock: blockSchema,
  mount: workspaceMountSchema,
})

export const listProjectCatalogContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/projects/catalog',
  responsesByStatusCode: { 200: v.array(projectSchema), ...errorResponses },
})

/** The definition versions of one project kind the board's account can pin on a new project. */
export const listPinnableProjectDefinitionsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: singleStringParam('kind'),
  pathResolver: ({ kind }) => `/project-kinds/${kind}/definitions`,
  responsesByStatusCode: { 200: v.array(pinnableProjectDefinitionSchema), ...errorResponses },
})

/** One project as the board reads it: its pin, outcomes, credential readiness and its kind's view. */
export const getProjectBoardViewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: projectIdParams,
  pathResolver: ({ projectId }) => `/projects/${projectId}/view`,
  responsesByStatusCode: { 200: projectBoardViewSchema, ...errorResponses },
})

export const getProjectOutcomeContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: withObjectKeys(
    v.object({ projectId: v.string(), outcomeId: v.string() }),
  ),
  pathResolver: ({ projectId, outcomeId }) => `/projects/${projectId}/outcomes/${outcomeId}`,
  responsesByStatusCode: { 200: projectOutcomeDetailSchema, ...errorResponses },
})

export const createProjectContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/projects',
  requestBodySchema: createProjectInputSchema,
  responsesByStatusCode: { 201: createdProjectSchema, ...errorResponses },
})

export const setProjectServicesContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: projectIdParams,
  pathResolver: ({ projectId }) => `/projects/${projectId}/services`,
  requestBodySchema: setProjectServicesInputSchema,
  responsesByStatusCode: { 200: projectSchema, ...errorResponses },
})

export const mountProjectContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: projectIdParams,
  pathResolver: ({ projectId }) => `/projects/${projectId}/mount`,
  requestBodySchema: mountServiceInputSchema,
  responsesByStatusCode: { 201: workspaceMountSchema, ...errorResponses },
})

export const updateProjectMountLayoutContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: projectIdParams,
  pathResolver: ({ projectId }) => `/projects/${projectId}/layout`,
  requestBodySchema: updateMountInputSchema,
  responsesByStatusCode: { 200: workspaceMountSchema, ...errorResponses },
})

export const unmountProjectContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: projectIdParams,
  pathResolver: ({ projectId }) => `/projects/${projectId}/mount`,
  responsesByStatusCode: { 204: noBodyResponse(), ...errorResponses },
})
