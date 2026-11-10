import {
  createProjectContract,
  listProjectCatalogContract,
  mountProjectContract,
  setProjectServicesContract,
  unmountProjectContract,
} from '@cat-factory/contracts'
import type { SendParams } from './client'
import type { ApiContext, Position } from './context'

type CreateProjectBody = NonNullable<SendParams<typeof createProjectContract>['body']>

/** Projects: account-owned peers of services, mounted onto boards. */
export function projectsApi({ send, ws }: ApiContext) {
  return {
    listProjectCatalog: (workspaceId: string) =>
      send(listProjectCatalogContract, { pathPrefix: ws(workspaceId) }),

    createProject: (workspaceId: string, body: CreateProjectBody) =>
      send(createProjectContract, { pathPrefix: ws(workspaceId), body }),

    setProjectServices: (workspaceId: string, projectId: string, serviceIds: string[]) =>
      send(setProjectServicesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { projectId },
        body: { serviceIds },
      }),

    mountProject: (workspaceId: string, projectId: string, body: { position?: Position } = {}) =>
      send(mountProjectContract, { pathPrefix: ws(workspaceId), pathParams: { projectId }, body }),

    unmountProject: (workspaceId: string, projectId: string) =>
      send(unmountProjectContract, { pathPrefix: ws(workspaceId), pathParams: { projectId } }),
  }
}
