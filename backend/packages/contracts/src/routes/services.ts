import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  mountServiceInputSchema,
  serviceSchema,
  updateMountInputSchema,
  workspaceMountSchema,
} from '../services.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// In-org shared service mount route contracts. See ServiceMountController in
// @cat-factory/server. Mounted under `/workspaces/:workspaceId`, so the paths
// here are relative to that prefix and `workspaceId` is NOT a contract param (the
// handler reads it via `param(c, 'workspaceId')`).
// ---------------------------------------------------------------------------

const workspaceMountListSchema = v.array(workspaceMountSchema)
const serviceListSchema = v.array(serviceSchema)
const serviceIdParams = withObjectKeys(v.object({ serviceId: v.string() }))

export const listServiceMountsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/services',
  responsesByStatusCode: { 200: workspaceMountListSchema, ...errorResponses },
})

export const listServiceCatalogContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/services/catalog',
  responsesByStatusCode: { 200: serviceListSchema, ...errorResponses },
})

export const mountServiceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/services/${serviceId}`,
  requestBodySchema: mountServiceInputSchema,
  responsesByStatusCode: { 201: workspaceMountSchema, ...errorResponses },
})

export const updateServiceMountLayoutContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/services/${serviceId}/layout`,
  requestBodySchema: updateMountInputSchema,
  responsesByStatusCode: { 200: workspaceMountSchema, ...errorResponses },
})

export const unmountServiceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: serviceIdParams,
  pathResolver: ({ serviceId }) => `/services/${serviceId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
