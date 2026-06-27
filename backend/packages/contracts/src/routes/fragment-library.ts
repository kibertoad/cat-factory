import { ContractNoBody, defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { promptFragmentSchema } from '../entities.js'
import {
  createDocumentFragmentSchema,
  createPromptFragmentSchema,
  fragmentSourceSchema,
  fragmentSourceStatusSchema,
  fragmentSyncResultSchema,
  linkFragmentSourceSchema,
  resolvedFragmentCatalogSchema,
  updatePromptFragmentSchema,
} from '../fragment-library.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Prompt-fragment library route contracts. See FragmentLibraryController in
// @cat-factory/server. The controller is mounted at BOTH `/accounts/:accountId`
// and `/workspaces/:workspaceId` from a single factory, so its route literals are
// RELATIVE to whichever prefix it is mounted under — the owner id (accountId /
// workspaceId) is read by the handler via its own param helper and is NOT a
// contract param. One set of relative contracts serves both mounts.
//
// Fragment ids are dot-separated (e.g. `node.performance`), never slash-bearing, so a
// plain `:fragmentId` (Hono's default `[^/]+`) matches them and the shared resolver works
// for both the server route and the client URL (a `{.+}` matcher would leak into the
// client-built URL).
// ---------------------------------------------------------------------------

const promptFragmentListSchema = v.array(promptFragmentSchema)
const fragmentSourceListSchema = v.array(fragmentSourceSchema)
const fragmentIdParams = withObjectKeys(v.object({ fragmentId: v.string() }))
const sourceIdParams = withObjectKeys(v.object({ id: v.string() }))

// ---- fragments (this tier, raw — not merged) ------------------------------

export const listPromptFragmentsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/prompt-fragments',
  responsesByStatusCode: { 200: promptFragmentListSchema, ...errorResponses },
})

export const createPromptFragmentContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/prompt-fragments',
  requestBodySchema: createPromptFragmentSchema,
  responsesByStatusCode: { 201: promptFragmentSchema, ...errorResponses },
})

export const updatePromptFragmentContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: fragmentIdParams,
  pathResolver: ({ fragmentId }) => `/prompt-fragments/${fragmentId}`,
  requestBodySchema: updatePromptFragmentSchema,
  responsesByStatusCode: { 200: promptFragmentSchema, ...errorResponses },
})

export const deletePromptFragmentContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: fragmentIdParams,
  pathResolver: ({ fragmentId }) => `/prompt-fragments/${fragmentId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

// ---- document-backed fragments (living source of truth) -------------------

export const createDocumentFragmentContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/document-fragments',
  requestBodySchema: createDocumentFragmentSchema,
  responsesByStatusCode: { 201: promptFragmentSchema, ...errorResponses },
})

export const refreshPromptFragmentContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: fragmentIdParams,
  // At the account scope the refresh needs a `viaWorkspaceId` (whose document-source
  // connection to fetch through); ignored at the workspace scope.
  requestQuerySchema: v.object({ viaWorkspaceId: v.optional(v.string()) }),
  pathResolver: ({ fragmentId }) => `/prompt-fragments/${fragmentId}/refresh`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: promptFragmentSchema, ...errorResponses },
})

// ---- repo sources ---------------------------------------------------------

export const listFragmentSourcesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/fragment-sources',
  responsesByStatusCode: { 200: fragmentSourceListSchema, ...errorResponses },
})

export const linkFragmentSourceContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/fragment-sources',
  requestBodySchema: linkFragmentSourceSchema,
  responsesByStatusCode: { 201: fragmentSourceSchema, ...errorResponses },
})

export const unlinkFragmentSourceContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/fragment-sources/${id}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const fragmentSourceStatusContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/fragment-sources/${id}/status`,
  responsesByStatusCode: { 200: fragmentSourceStatusSchema, ...errorResponses },
})

export const syncFragmentSourceContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceIdParams,
  pathResolver: ({ id }) => `/fragment-sources/${id}/sync`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: fragmentSyncResultSchema, ...errorResponses },
})

// ---- resolved (workspace only) — the merged catalog an agent sees ---------

export const resolvedFragmentsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/prompt-fragments/resolved',
  responsesByStatusCode: { 200: resolvedFragmentCatalogSchema, ...errorResponses },
})
