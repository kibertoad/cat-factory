import { defineApiContract, noBodyResponse } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { connectionTestResultSchema, providerDescriptorSchema } from '../provider-config.js'
import {
  accountRunnerPoolSummarySchema,
  registerRunnerPoolSchema,
  runnerPoolConnectionSchema,
  testRunnerPoolConnectionSchema,
  updateRunnerPoolSecretsSchema,
} from '../runners.js'
import { booleanQuerySchema } from '../public-paging.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Self-hosted runner-pool route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See RunnerPoolController.
// ---------------------------------------------------------------------------

// Response wrapper that exists only inline in the controller today.
const runnerPoolConnectionViewSchema = v.object({
  connection: v.nullable(runnerPoolConnectionSchema),
  /** The account's pool, in use or not; null for a board with no account or an account with none. */
  accountPool: v.nullable(accountRunnerPoolSummarySchema),
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
  // Removing a board's own pool stops the board inheriting its account's pool, unless the admin
  // asks to fall back (`fallBackToAccount=true`), which turns inheriting back on even for a board
  // that had opted out: a deletion must never silently re-route a board's work to a pool it did
  // not choose, nor leave it on none when the admin chose the account's. Omitted ⇒ `false`.
  requestQuerySchema: v.object({ fallBackToAccount: v.optional(booleanQuerySchema) }),
  responsesByStatusCode: { 204: noBodyResponse(), ...errorResponses },
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
