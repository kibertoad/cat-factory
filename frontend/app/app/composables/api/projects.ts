import {
  createProjectContract,
  getFindingsStoragePolicyContract,
  getResearchProjectViewContract,
  getResearchRevisionContract,
  listPinnableResearchDefinitionsContract,
  listProjectCatalogContract,
  mountProjectContract,
  setProjectServicesContract,
  setFindingsStoragePolicyContract,
  unmountProjectContract,
} from '@cat-factory/contracts'
import type { SendParams } from './client'
import type { ApiContext, Position } from './context'

type CreateProjectBody = NonNullable<SendParams<typeof createProjectContract>['body']>
type SetFindingsStoragePolicyBody = NonNullable<
  SendParams<typeof setFindingsStoragePolicyContract>['body']
>

/** Projects: account-owned peers of services, mounted onto boards. */
export function projectsApi({ send, ws }: ApiContext) {
  return {
    listProjectCatalog: (workspaceId: string) =>
      send(listProjectCatalogContract, { pathPrefix: ws(workspaceId) }),

    listPinnableResearchDefinitions: (workspaceId: string) =>
      send(listPinnableResearchDefinitionsContract, { pathPrefix: ws(workspaceId) }),

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

    getResearchProjectView: (workspaceId: string, projectId: string) =>
      send(getResearchProjectViewContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { projectId },
      }),

    getResearchRevision: (workspaceId: string, projectId: string, revisionId: string) =>
      send(getResearchRevisionContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { projectId, revisionId },
      }),

    getFindingsStoragePolicy: (workspaceId: string, projectId?: string) =>
      send(getFindingsStoragePolicyContract, {
        pathPrefix: ws(workspaceId),
        queryParams: projectId ? { projectId } : {},
      }),

    setFindingsStoragePolicy: (workspaceId: string, body: SetFindingsStoragePolicyBody) =>
      send(setFindingsStoragePolicyContract, { pathPrefix: ws(workspaceId), body }),
  }
}
