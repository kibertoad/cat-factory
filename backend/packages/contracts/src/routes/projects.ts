import { defineApiContract, noBodyResponse, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema } from '../entities.js'
import { pinnableResearchDefinitionSchema } from '../research.js'
import { researchProjectViewSchema, researchRevisionDetailSchema } from '../research-view.js'
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

/** The research definition versions the board's account can pin on a new research project. */
export const listPinnableResearchDefinitionsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/research-definitions',
  responsesByStatusCode: { 200: v.array(pinnableResearchDefinitionSchema), ...errorResponses },
})

/** A research project's pin, current findings, revisions and credential readiness. */
export const getResearchProjectViewContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: projectIdParams,
  pathResolver: ({ projectId }) => `/projects/${projectId}/research`,
  responsesByStatusCode: { 200: researchProjectViewSchema, ...errorResponses },
})

export const getResearchRevisionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: withObjectKeys(
    v.object({ projectId: v.string(), revisionId: v.string() }),
  ),
  pathResolver: ({ projectId, revisionId }) =>
    `/projects/${projectId}/research/revisions/${revisionId}`,
  responsesByStatusCode: { 200: researchRevisionDetailSchema, ...errorResponses },
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
