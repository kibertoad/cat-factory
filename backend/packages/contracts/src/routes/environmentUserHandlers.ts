import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  environmentHandlerViewSchema,
  upsertEnvironmentUserHandlerBodySchema,
} from '../environments.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-USER infra handler override route contracts (local mode). The
// EnvironmentUserHandlerController is mounted at `/`, so the paths are absolute and carry
// no `/workspaces` prefix; the overrides are scoped to the signed-in user (like local model
// runners + personal subscriptions). The service is wired ONLY by the local facade, so these
// 503 elsewhere. See EnvironmentUserHandlerController in @cat-factory/server.
// ---------------------------------------------------------------------------

const workspaceParams = singleStringParam('workspaceId')
const workspaceTypeParams = withObjectKeys(
  v.object({ workspaceId: v.string(), provisionType: v.string() }),
)

const environmentUserHandlerListSchema = v.object({
  handlers: v.array(environmentHandlerViewSchema),
})

export const listEnvironmentUserHandlersContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: workspaceParams,
  pathResolver: ({ workspaceId }) => `/me/environment-handlers/${workspaceId}`,
  responsesByStatusCode: { 200: environmentUserHandlerListSchema, ...errorResponses },
})

export const upsertEnvironmentUserHandlerContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: workspaceTypeParams,
  // The `provisionType` is taken from the path, so the body carries only the config +
  // secrets (+ optional manifestId/backendKind) and does NOT re-send a provisionType.
  pathResolver: ({ workspaceId, provisionType }) =>
    `/me/environment-handlers/${workspaceId}/${provisionType}`,
  requestBodySchema: upsertEnvironmentUserHandlerBodySchema,
  responsesByStatusCode: { 201: environmentHandlerViewSchema, ...errorResponses },
})

export const removeEnvironmentUserHandlerContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: workspaceTypeParams,
  // `manifestId` keys a `custom` override; absent ⇒ the bare (non-custom) override.
  requestQuerySchema: v.object({ manifestId: v.optional(v.string()) }),
  pathResolver: ({ workspaceId, provisionType }) =>
    `/me/environment-handlers/${workspaceId}/${provisionType}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
