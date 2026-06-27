import { defineApiContract } from '@toad-contracts/valibot'
import {
  serviceFragmentDefaultsSchema,
  setServiceFragmentDefaultsSchema,
} from '../service-fragment-defaults.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Service-fragment-defaults route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See ServiceFragmentDefaultsController
// in @cat-factory/server.
// ---------------------------------------------------------------------------

export const getServiceFragmentDefaultsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/service-fragment-defaults',
  responsesByStatusCode: { 200: serviceFragmentDefaultsSchema, ...errorResponses },
})

export const setServiceFragmentDefaultsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/service-fragment-defaults',
  requestBodySchema: setServiceFragmentDefaultsSchema,
  responsesByStatusCode: { 200: serviceFragmentDefaultsSchema, ...errorResponses },
})
