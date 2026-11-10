// The answers to the foundational-services manager's probe, for the surfaces that mount the whole
// manager (the board's modal and the account's tab): the tier's own services, the merged catalog
// (board only), the opt-outs, the linked sources and the board's portal connection. With
// `available: false` the first read answers the 503 a deployment without the catalog sends, which
// is how the manager learns the feature is off; with `failed: true` it answers a 500, a read that
// did not answer. The message is the controller's (`FoundationalServiceController`).
import {
  getServiceCatalogContract,
  listFoundationalServicesContract,
  listFoundationalServiceSourcesContract,
  listFoundationalServiceSuppressionsContract,
  resolvedFoundationalServicesContract,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiFailure, apiRefusal, apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import type { FoundationalCatalogSeed } from './withStores'

export function foundationalApi(
  owner: { accountId: string } | 'workspace',
  seed: FoundationalCatalogSeed & { available?: boolean; failed?: boolean } = {},
): HttpHandler[] {
  const pathPrefix = owner === 'workspace' ? storyWorkspacePrefix : `/accounts/${owner.accountId}`
  if (seed.available === false || seed.failed) {
    // The opt-out read and, for a board, the merged catalog read run beside the failing one, so
    // they are answered too.
    return [
      seed.failed
        ? apiFailure(listFoundationalServicesContract, { pathPrefix })
        : apiRefusal(listFoundationalServicesContract, {
            pathPrefix,
            status: 503,
            error: {
              code: 'unavailable',
              message: 'The foundational-services catalog is not configured',
            },
          }),
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
