import {
  deleteServiceValidationConfigContract,
  detectServiceValidationChecksContract,
  getServiceValidationConfigContract,
  listServiceValidationConfigsContract,
  setServiceValidationConfigContract,
} from '@cat-factory/contracts'
import type { UpsertServiceValidationConfigInput } from '~/types/validationChecks'
import type { ApiContext } from './context'

/** Pre-PR validation checks: the per-service-frame commands the harness runs before opening a PR. */
export function validationChecksApi({ send, ws }: ApiContext) {
  return {
    listServiceValidationConfigs: (workspaceId: string) =>
      send(listServiceValidationConfigsContract, { pathPrefix: ws(workspaceId) }),

    getServiceValidationConfig: (workspaceId: string, blockId: string) =>
      send(getServiceValidationConfigContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),

    setServiceValidationConfig: (
      workspaceId: string,
      blockId: string,
      body: UpsertServiceValidationConfigInput,
    ) =>
      send(setServiceValidationConfigContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body,
      }),

    /** Suggest checks from the service repo's manifests — a read; the operator still saves. */
    detectServiceValidationChecks: (workspaceId: string, blockId: string) =>
      send(detectServiceValidationChecksContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),

    deleteServiceValidationConfig: (workspaceId: string, blockId: string) =>
      send(deleteServiceValidationConfigContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
      }),
  }
}
