import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { executionInstanceSchema } from '../execution.js'
import { requestHumanTestFixSchema } from '../human-test.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Human-testing gate route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. Each route drives the block's
// parked `human-test` step and returns the updated execution instance. See
// HumanTestController in @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

export const confirmHumanTestContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/human-test/confirm`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const requestHumanTestFixContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/human-test/request-fix`,
  requestBodySchema: requestHumanTestFixSchema,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const pullMainHumanTestContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/human-test/pull-main`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const recreateHumanTestEnvContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/human-test/recreate-env`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})

export const destroyHumanTestEnvContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/human-test/destroy-env`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: executionInstanceSchema, ...errorResponses },
})
