import {
  addPackageRegistryContract,
  deletePackageRegistryContract,
  listPackageRegistriesContract,
} from '@cat-factory/contracts'
import type { AddPackageRegistryInput } from '~/types/packageRegistries'
import type { ApiContext } from './context'

/** Private package registries: the workspace's entries agent containers install with. */
export function packageRegistriesApi({ send, ws }: ApiContext) {
  return {
    listPackageRegistries: (workspaceId: string) =>
      send(listPackageRegistriesContract, { pathPrefix: ws(workspaceId) }),

    addPackageRegistry: (workspaceId: string, body: AddPackageRegistryInput) =>
      send(addPackageRegistryContract, { pathPrefix: ws(workspaceId), body }),

    deletePackageRegistry: (workspaceId: string, entryId: string) =>
      send(deletePackageRegistryContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { entryId },
      }),
  }
}
