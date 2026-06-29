import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { connectionTestResultSchema, providerDescriptorSchema } from '../provider-config.js'
import {
  registerRunnerPoolSchema,
  runnerPoolConnectionSchema,
  testRunnerPoolConnectionSchema,
  updateRunnerPoolSecretsSchema,
} from '../runners.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Self-hosted runner-pool route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See RunnerPoolController.
// ---------------------------------------------------------------------------

// Response wrapper that exists only inline in the controller today.
const runnerPoolConnectionViewSchema = v.object({
  connection: v.nullable(runnerPoolConnectionSchema),
})

export const getRunnerPoolConnectionContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/runner-pool/connection',
  responsesByStatusCode: { 200: runnerPoolConnectionViewSchema, ...errorResponses },
})

export const registerRunnerPoolContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/runner-pool/connection',
  requestBodySchema: registerRunnerPoolSchema,
  responsesByStatusCode: { 201: runnerPoolConnectionSchema, ...errorResponses },
})

export const updateRunnerPoolSecretsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/runner-pool/connection/secrets',
  requestBodySchema: updateRunnerPoolSecretsSchema,
  responsesByStatusCode: { 200: runnerPoolConnectionSchema, ...errorResponses },
})

export const unregisterRunnerPoolContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/runner-pool/connection',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const describeRunnerPoolProviderContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/runner-pool/provider',
  // Optional `kind` describes a REGISTERED backend that isn't connected yet. Omitted ⇒ the
  // stored kind, else the default `manifest` backend.
  requestQuerySchema: v.object({ kind: v.optional(v.string()) }),
  responsesByStatusCode: { 200: providerDescriptorSchema, ...errorResponses },
})

export const testRunnerPoolConnectionContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/runner-pool/connection/test',
  requestBodySchema: testRunnerPoolConnectionSchema,
  responsesByStatusCode: { 200: connectionTestResultSchema, ...errorResponses },
})
