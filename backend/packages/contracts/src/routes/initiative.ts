import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { blockSchema } from '../entities.js'
import { createInitiativeSchema, initiativeSchema } from '../initiative.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Initiative route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. See InitiativeController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const initiativeIdParams = singleStringParam('initiativeId')
const blockIdParams = singleStringParam('blockId')

/**
 * Create an initiative: materialises the initiative-level board block AND its
 * empty entity in one call, returning both so the client patches its board and
 * initiative caches without a refetch.
 */
export const createInitiativeContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/initiatives',
  requestBodySchema: createInitiativeSchema,
  responsesByStatusCode: {
    201: v.object({ initiative: initiativeSchema, block: blockSchema }),
    ...errorResponses,
  },
})

export const listInitiativesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/initiatives',
  responsesByStatusCode: { 200: v.array(initiativeSchema), ...errorResponses },
})

export const getInitiativeContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: initiativeIdParams,
  pathResolver: ({ initiativeId }) => `/initiatives/${initiativeId}`,
  responsesByStatusCode: { 200: initiativeSchema, ...errorResponses },
})

/** Fetch the initiative anchored to a board block (the tracker window's load path). */
export const getInitiativeByBlockContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/initiative`,
  responsesByStatusCode: { 200: v.nullable(initiativeSchema), ...errorResponses },
})
