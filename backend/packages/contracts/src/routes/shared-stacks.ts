import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  createSharedStackSchema,
  sharedStackSchema,
  updateSharedStackSchema,
} from '../shared-stacks.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Shared-stack route contracts. Mounted under `/workspaces/:workspaceId`, so the
// paths here are relative to that prefix. CRUD plus the two lifecycle actions
// (`ensure-up` / `teardown`). See SharedStackController in @cat-factory/server.
// ---------------------------------------------------------------------------

const sharedStackListSchema = v.array(sharedStackSchema)
const stackIdParams = singleStringParam('stackId')

export const listSharedStacksContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/shared-stacks',
  responsesByStatusCode: { 200: sharedStackListSchema, ...errorResponses },
})

export const createSharedStackContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/shared-stacks',
  requestBodySchema: createSharedStackSchema,
  responsesByStatusCode: { 201: sharedStackSchema, ...errorResponses },
})

export const updateSharedStackContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: stackIdParams,
  pathResolver: ({ stackId }) => `/shared-stacks/${stackId}`,
  requestBodySchema: updateSharedStackSchema,
  responsesByStatusCode: { 200: sharedStackSchema, ...errorResponses },
})

export const deleteSharedStackContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: stackIdParams,
  pathResolver: ({ stackId }) => `/shared-stacks/${stackId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

/**
 * Bring a shared stack up (idempotent): clone/refresh the repo, create its managed networks,
 * `up -d` under its profiles, run its setup steps, then poll its health gate. Already-running ⇒
 * a no-op that returns the current record. Runs only on the local (host-Docker) facade.
 */
export const ensureSharedStackUpContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: stackIdParams,
  pathResolver: ({ stackId }) => `/shared-stacks/${stackId}/ensure-up`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: sharedStackSchema, ...errorResponses },
})

/** Tear a shared stack down (`down -v`) — a deliberate action; the stack is never swept. */
export const teardownSharedStackContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: stackIdParams,
  pathResolver: ({ stackId }) => `/shared-stacks/${stackId}/teardown`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: sharedStackSchema, ...errorResponses },
})
