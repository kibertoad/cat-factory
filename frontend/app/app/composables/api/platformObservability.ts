import { getPlatformObservabilityContract } from '@cat-factory/contracts'
import type { PlatformObservabilityWindow } from '~/types/execution'
import type { ApiContext } from './context'

/**
 * Platform-operator observability: the deployment-level aggregate health of an
 * account's runs over a time window (admin-gated). The dual of `executionApi`'s
 * per-run `getLlmMetrics` — account-scoped, not workspace-scoped.
 */
export function platformObservabilityApi({ send }: ApiContext) {
  return {
    getPlatformObservability: (accountId: string, window: PlatformObservabilityWindow) =>
      send(getPlatformObservabilityContract, {
        pathParams: { accountId },
        queryParams: { window },
      }),
  }
}
