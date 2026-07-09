import {
  deleteServiceTestSecretsContract,
  getServiceTestSecretsContract,
  setServiceTestSecretsContract,
} from '@cat-factory/contracts'
import type { UpsertServiceTestSecretsInput } from '~/types/testSecrets'
import type { ApiContext } from './context'

/**
 * Sensitive per-service test secrets (SEALED, write-only). The GET view returns only the
 * configured keys + descriptions; the PUT replaces the whole set (values write-only) and
 * an empty set clears it. Keyed by the service-frame block. See TestSecretsController.
 */
export function testSecretsApi({ send, ws }: ApiContext) {
  return {
    getServiceTestSecrets: (workspaceId: string, blockId: string) =>
      send(getServiceTestSecretsContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),

    setServiceTestSecrets: (
      workspaceId: string,
      blockId: string,
      body: UpsertServiceTestSecretsInput,
    ) =>
      send(setServiceTestSecretsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    deleteServiceTestSecrets: (workspaceId: string, blockId: string) =>
      send(deleteServiceTestSecretsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),
  }
}
