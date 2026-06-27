import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { blockSchema } from '../entities.js'
import {
  addEpicSchema,
  addFrameSchema,
  addModuleSchema,
  addServiceFromRepoSchema,
  addTaskSchema,
  assignEpicSchema,
  moveBlockSchema,
  reparentSchema,
  toggleDependencySchema,
  updateBlockSchema,
} from '../requests.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Board mutation route contracts. Mounted under `/workspaces/:workspaceId`, so
// the paths here are relative to that prefix. See BoardController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

export const addFrameContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/blocks',
  requestBodySchema: addFrameSchema,
  responsesByStatusCode: { 201: blockSchema, ...errorResponses },
})

export const addServiceFromRepoContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/blocks/from-repo',
  requestBodySchema: addServiceFromRepoSchema,
  responsesByStatusCode: { 201: blockSchema, ...errorResponses },
})

export const addTaskContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/tasks`,
  requestBodySchema: addTaskSchema,
  responsesByStatusCode: { 201: blockSchema, ...errorResponses },
})

export const addModuleContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/modules`,
  requestBodySchema: addModuleSchema,
  responsesByStatusCode: { 201: blockSchema, ...errorResponses },
})

export const addEpicContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/epics',
  requestBodySchema: addEpicSchema,
  responsesByStatusCode: { 201: blockSchema, ...errorResponses },
})

export const assignEpicContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/epic`,
  requestBodySchema: assignEpicSchema,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})

export const updateBlockContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}`,
  requestBodySchema: updateBlockSchema,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})

export const moveBlockContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/move`,
  requestBodySchema: moveBlockSchema,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})

export const reparentBlockContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/reparent`,
  requestBodySchema: reparentSchema,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})

export const removeBlockContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const toggleDependencyContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/dependencies`,
  requestBodySchema: toggleDependencySchema,
  responsesByStatusCode: { 200: blockSchema, ...errorResponses },
})
