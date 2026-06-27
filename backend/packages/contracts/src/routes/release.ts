import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  observabilityConnectionViewSchema,
  releaseHealthConfigSchema,
  upsertObservabilityConnectionSchema,
  upsertReleaseHealthConfigSchema,
} from '../release.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Post-release-health route contracts: the per-workspace observability connection
// and the per-block monitor/SLO mappings the gate reads. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
// See ReleaseHealthController.
// ---------------------------------------------------------------------------

const releaseHealthConfigListSchema = v.array(releaseHealthConfigSchema)
const blockIdParams = singleStringParam('blockId')

export const getObservabilityConnectionContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/observability/connection',
  responsesByStatusCode: { 200: observabilityConnectionViewSchema, ...errorResponses },
})

export const setObservabilityConnectionContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/observability/connection',
  requestBodySchema: upsertObservabilityConnectionSchema,
  responsesByStatusCode: { 200: observabilityConnectionViewSchema, ...errorResponses },
})

export const deleteObservabilityConnectionContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/observability/connection',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const listReleaseHealthConfigsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/release-health-configs',
  responsesByStatusCode: { 200: releaseHealthConfigListSchema, ...errorResponses },
})

export const upsertReleaseHealthConfigContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/release-health-configs/${blockId}`,
  requestBodySchema: upsertReleaseHealthConfigSchema,
  responsesByStatusCode: { 200: releaseHealthConfigSchema, ...errorResponses },
})

export const deleteReleaseHealthConfigContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/release-health-configs/${blockId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
