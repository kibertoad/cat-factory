import {
  createProjectContract,
  getOutcomeStoragePolicyContract,
  getProjectBoardViewContract,
  getProjectOutcomeContract,
  listPinnableProjectDefinitionsContract,
  listProjectCatalogContract,
  mountProjectContract,
  setProjectServicesContract,
  setOutcomeStoragePolicyContract,
  unmountProjectContract,
} from '@cat-factory/contracts'
import type { SendParams } from './client'
import type { ApiContext, Position } from './context'

type CreateProjectBody = NonNullable<SendParams<typeof createProjectContract>['body']>
type SetOutcomeStoragePolicyBody = NonNullable<
  SendParams<typeof setOutcomeStoragePolicyContract>['body']
>

/** Projects: account-owned peers of services, mounted onto boards. */
export function projectsApi({ send, ws }: ApiContext) {
  return {
    listProjectCatalog: (workspaceId: string) =>
      send(listProjectCatalogContract, { pathPrefix: ws(workspaceId) }),

    listPinnableProjectDefinitions: (workspaceId: string, kind: string) =>
      send(listPinnableProjectDefinitionsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { kind },
      }),

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

    getProjectBoardView: (workspaceId: string, projectId: string) =>
      send(getProjectBoardViewContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { projectId },
      }),

    getProjectOutcome: (workspaceId: string, projectId: string, outcomeId: string) =>
      send(getProjectOutcomeContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { projectId, outcomeId },
      }),

    getOutcomeStoragePolicy: (workspaceId: string, projectId?: string) =>
      send(getOutcomeStoragePolicyContract, {
        pathPrefix: ws(workspaceId),
        queryParams: projectId ? { projectId } : {},
      }),

    setOutcomeStoragePolicy: (workspaceId: string, body: SetOutcomeStoragePolicyBody) =>
      send(setOutcomeStoragePolicyContract, { pathPrefix: ws(workspaceId), body }),
  }
}
