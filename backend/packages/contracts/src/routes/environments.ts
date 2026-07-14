import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  bootstrapEnvironmentRepoSchema,
  customManifestTypeSchema,
  detectServiceProvisioningSchema,
  environmentConnectionSchema,
  environmentHandleSchema,
  environmentHandlerViewSchema,
  environmentHandlersBundleSchema,
  provisionEnvironmentSchema,
  provisioningRecommendationSchema,
  registerEnvironmentHandlerSchema,
  registerEnvironmentProviderSchema,
  repairCustomManifestSchema,
  testEnvironmentConnectionSchema,
  testEnvironmentHandlerSchema,
  updateEnvironmentSecretsSchema,
  upsertCustomManifestTypeSchema,
  validateEnvironmentRepoSchema,
} from '../environments.js'
import {
  bootstrapRepoResultSchema,
  connectionTestResultSchema,
  providerDescriptorSchema,
  repoValidationResultSchema,
} from '../provider-config.js'
import { detectFrontendConfigSchema, frontendConfigRecommendationSchema } from '../frontend.js'
import { environmentTestRunSchema } from '../environment-test.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Ephemeral-environment route contracts: provider registration (manifest +
// encrypted secret bundle), the environment registry, manual provision/teardown,
// and the dedicated access endpoint that returns decrypted creds over TLS.
// Mounted under `/workspaces/:workspaceId`, so the paths here are relative to
// that prefix. See EnvironmentController.
// ---------------------------------------------------------------------------

const environmentIdParams = singleStringParam('environmentId')

// Response wrapper that exists only inline in the controller today.
const environmentConnectionViewSchema = v.object({
  connection: v.nullable(environmentConnectionSchema),
})
const environmentHandleListSchema = v.array(environmentHandleSchema)

export const getEnvironmentConnectionContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/environments/connection',
  responsesByStatusCode: { 200: environmentConnectionViewSchema, ...errorResponses },
})

export const registerEnvironmentProviderContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/connection',
  requestBodySchema: registerEnvironmentProviderSchema,
  responsesByStatusCode: { 201: environmentConnectionSchema, ...errorResponses },
})

export const updateEnvironmentSecretsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/environments/connection/secrets',
  requestBodySchema: updateEnvironmentSecretsSchema,
  responsesByStatusCode: { 200: environmentConnectionSchema, ...errorResponses },
})

export const unregisterEnvironmentProviderContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/environments/connection',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const describeEnvironmentProviderContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/environments/provider',
  // Optional `kind` describes a REGISTERED backend that isn't connected yet (so the SPA can
  // render a custom kind's connect form pre-connection). Omitted ⇒ the stored kind, else the
  // default `manifest` backend.
  requestQuerySchema: v.object({ kind: v.optional(v.string()) }),
  responsesByStatusCode: { 200: providerDescriptorSchema, ...errorResponses },
})

export const testEnvironmentConnectionContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/connection/test',
  requestBodySchema: testEnvironmentConnectionSchema,
  responsesByStatusCode: { 200: connectionTestResultSchema, ...errorResponses },
})

// Validate that a target repo satisfies the provider's config expectations (e.g. a
// provider's `.deploy.yml` is present + well-formed). Nothing persisted.
export const validateEnvironmentRepoContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/connection/validate-repo',
  requestBodySchema: validateEnvironmentRepoSchema,
  responsesByStatusCode: { 200: repoValidationResultSchema, ...errorResponses },
})

// Mechanically bootstrap (and optionally agent-repair) the provider's config file in
// a target repo from UI-collected variables.
export const bootstrapEnvironmentRepoContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/connection/bootstrap-repo',
  requestBodySchema: bootstrapEnvironmentRepoSchema,
  responsesByStatusCode: { 200: bootstrapRepoResultSchema, ...errorResponses },
})

// Auto-detect a NON-BINDING recommended provisioning config from a service's repo (read
// checkout-free over RepoFiles). Nothing persisted — the SPA prefills the confirm form.
export const detectServiceProvisioningContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/detect-provisioning',
  requestBodySchema: detectServiceProvisioningSchema,
  responsesByStatusCode: { 200: provisioningRecommendationSchema, ...errorResponses },
})

// Auto-detect a NON-BINDING recommended FRONTEND config from a frontend repo (read checkout-free
// over RepoFiles). Nothing persisted — the SPA prefills a preview the user applies.
export const detectFrontendConfigContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/detect-frontend-config',
  requestBodySchema: detectFrontendConfigSchema,
  responsesByStatusCode: { 200: frontendConfigRecommendationSchema, ...errorResponses },
})

// Generate (or fix) a service's custom manifest file via the fixer coding agent. Returns a
// BootstrapRepoResult-shaped body: an async `env-config-repair` run is dispatched (usedAgent +
// repairJobId) and tracked exactly like the provider-config repair fallback.
export const repairCustomManifestContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/custom-manifest/repair',
  requestBodySchema: repairCustomManifestSchema,
  responsesByStatusCode: { 200: bootstrapRepoResultSchema, ...errorResponses },
})

// ---- per-type infra handlers (the workspace "how") + custom-type catalog ----

const provisionTypeParams = singleStringParam('provisionType')
const manifestIdParams = singleStringParam('manifestId')
// `manifestId` keys a `custom` handler; absent ⇒ the bare (non-custom) handler.
const handlerManifestIdQuery = v.object({ manifestId: v.optional(v.string()) })

// The batched bundle: every registered handler + the custom-manifest-type catalog
// (registered code types + workspace rows), so the infra configurator loads in one call.
export const listEnvironmentHandlersContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/environments/handlers',
  responsesByStatusCode: { 200: environmentHandlersBundleSchema, ...errorResponses },
})

export const registerEnvironmentHandlerContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/handlers',
  requestBodySchema: registerEnvironmentHandlerSchema,
  responsesByStatusCode: { 201: environmentHandlerViewSchema, ...errorResponses },
})

// Probe a candidate per-type handler connection before saving (nothing persisted). The body
// is the engine connection config + its secret bundle; the path is distinct from the
// `:provisionType`-keyed handler routes so it never collides with them.
export const testEnvironmentHandlerContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/handlers/test',
  requestBodySchema: testEnvironmentHandlerSchema,
  responsesByStatusCode: { 200: connectionTestResultSchema, ...errorResponses },
})

export const updateEnvironmentHandlerSecretsContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: provisionTypeParams,
  requestQuerySchema: handlerManifestIdQuery,
  pathResolver: ({ provisionType }) => `/environments/handlers/${provisionType}/secrets`,
  requestBodySchema: updateEnvironmentSecretsSchema,
  responsesByStatusCode: { 200: environmentHandlerViewSchema, ...errorResponses },
})

export const unregisterEnvironmentHandlerContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: provisionTypeParams,
  requestQuerySchema: handlerManifestIdQuery,
  pathResolver: ({ provisionType }) => `/environments/handlers/${provisionType}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const upsertCustomManifestTypeContract = defineApiContract({
  method: 'put',
  requestPathParamsSchema: manifestIdParams,
  pathResolver: ({ manifestId }) => `/environments/custom-types/${manifestId}`,
  requestBodySchema: upsertCustomManifestTypeSchema,
  responsesByStatusCode: { 200: customManifestTypeSchema, ...errorResponses },
})

export const removeCustomManifestTypeContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: manifestIdParams,
  pathResolver: ({ manifestId }) => `/environments/custom-types/${manifestId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const listEnvironmentsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/environments',
  responsesByStatusCode: { 200: environmentHandleListSchema, ...errorResponses },
})

export const getEnvironmentContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: environmentIdParams,
  pathResolver: ({ environmentId }) => `/environments/${environmentId}`,
  responsesByStatusCode: { 200: environmentHandleSchema, ...errorResponses },
})

export const getEnvironmentAccessContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: environmentIdParams,
  pathResolver: ({ environmentId }) => `/environments/${environmentId}/access`,
  responsesByStatusCode: { 200: environmentHandleSchema, ...errorResponses },
})

export const provisionEnvironmentContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/environments/provision',
  requestBodySchema: provisionEnvironmentSchema,
  responsesByStatusCode: { 201: environmentHandleSchema, ...errorResponses },
})

export const teardownEnvironmentContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: environmentIdParams,
  pathResolver: ({ environmentId }) => `/environments/${environmentId}/teardown`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: environmentHandleSchema, ...errorResponses },
})

// ---- ephemeral-environment self-test (diagnostic) -----------------------

const environmentTestIdParams = singleStringParam('id')
const environmentTestBlockParams = singleStringParam('blockId')

/** Start an environment-test run against a service frame's provisioning config. */
export const startEnvironmentTestContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: environmentTestBlockParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/environment-test`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 201: environmentTestRunSchema, ...errorResponses },
})

/** Read one environment-test run's current stage + outcome. */
export const getEnvironmentTestContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: environmentTestIdParams,
  pathResolver: ({ id }) => `/environment-tests/${id}`,
  responsesByStatusCode: { 200: environmentTestRunSchema, ...errorResponses },
})

/** Stop a running environment-test run (best-effort cleanup then mark failed/cancelled). */
export const stopEnvironmentTestContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: environmentTestIdParams,
  pathResolver: ({ id }) => `/environment-tests/${id}/stop`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: environmentTestRunSchema, ...errorResponses },
})
