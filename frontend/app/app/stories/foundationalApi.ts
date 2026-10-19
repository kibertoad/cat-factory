// The answers to the foundational-services manager's probe, for the surfaces that mount the whole
// manager (the board's modal and the account's tab): the tier's own services, the merged catalog
// (board only), the opt-outs, the linked sources and the board's portal connection. With
// `available: false` the first read fails, which is how the manager learns the feature is off.
import {
  getServiceCatalogContract,
  listFoundationalServicesContract,
  listFoundationalServiceSourcesContract,
  listFoundationalServiceSuppressionsContract,
  resolvedFoundationalServicesContract,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiFailure, apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import type { FoundationalCatalogSeed } from './withStores'

export function foundationalApi(
  owner: { accountId: string } | 'workspace',
  seed: FoundationalCatalogSeed & { available?: boolean } = {},
): HttpHandler[] {
  const pathPrefix = owner === 'workspace' ? storyWorkspacePrefix : `/accounts/${owner.accountId}`
  if (seed.available === false) {
    // The opt-out read and, for a board, the merged catalog read run beside the failing one, so
    // they are answered too.
    return [
      apiFailure(listFoundationalServicesContract, { pathPrefix }),
      apiResponse(listFoundationalServiceSuppressionsContract, { pathPrefix, body: [] }),
      ...(owner === 'workspace'
        ? [apiResponse(resolvedFoundationalServicesContract, { pathPrefix, body: [] })]
        : []),
    ]
  }
  return [
    apiResponse(listFoundationalServicesContract, { pathPrefix, body: seed.services ?? [] }),
    apiResponse(listFoundationalServiceSuppressionsContract, {
      pathPrefix,
      body: seed.suppressions ?? [],
    }),
    apiResponse(listFoundationalServiceSourcesContract, { pathPrefix, body: seed.sources ?? [] }),
    ...(owner === 'workspace'
      ? [
          apiResponse(resolvedFoundationalServicesContract, {
            pathPrefix,
            body: seed.resolved ?? [],
          }),
          apiResponse(getServiceCatalogContract, {
            pathPrefix,
            body: seed.serviceCatalog ?? null,
          }),
        ]
      : []),
  ]
}
