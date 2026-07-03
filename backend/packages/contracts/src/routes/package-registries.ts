import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import { addPackageRegistrySchema, packageRegistryListSchema } from '../package-registries.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Private package registry route contracts: the workspace's registry entries
// agent containers use to resolve private dependencies. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
// Edit = delete + re-add (tokens are write-only, so a whole-list PUT would
// force re-sending every token). See PackageRegistriesController.
// ---------------------------------------------------------------------------

const entryIdParams = singleStringParam('entryId')

export const listPackageRegistriesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/package-registries',
  responsesByStatusCode: { 200: packageRegistryListSchema, ...errorResponses },
})

export const addPackageRegistryContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/package-registries',
  requestBodySchema: addPackageRegistrySchema,
  responsesByStatusCode: { 200: packageRegistryListSchema, ...errorResponses },
})

export const deletePackageRegistryContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: entryIdParams,
  pathResolver: ({ entryId }) => `/package-registries/${entryId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
