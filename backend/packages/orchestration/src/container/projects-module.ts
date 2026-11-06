import type {
  ExecutionEventPublisher,
  ProjectKindSource,
  RegisteredResearchDefinitionSource,
  ResearchDefinitionSource,
} from '@cat-factory/kernel'
import type { ProjectsModule } from '../container.js'
import { ProjectService } from '../modules/projects/ProjectService.js'
import { FindingsStoragePolicyService } from '../modules/research/FindingsStoragePolicyService.js'
import { ResearchDefinitionPublisher } from '../modules/research/ResearchDefinitionPublisher.js'
import { ResearchProjectViews } from '../modules/research/ResearchProjectViews.js'
import { createResearchFindingsStore } from '../modules/research/createResearchStepController.js'
import type { CoreDependencies } from './dependencies.js'

/** Assemble the projects module when the project, service and mount repositories are wired. */
export function createProjectsModule(
  deps: CoreDependencies,
  sources: {
    projectKinds: ProjectKindSource
    researchDefinitions: ResearchDefinitionSource
    registeredResearchDefinitions: RegisteredResearchDefinitionSource
  },
  events: ExecutionEventPublisher,
): ProjectsModule | undefined {
  const {
    projectRepository,
    serviceRepository,
    workspaceMountRepository,
    researchProjectRepository,
  } = deps
  if (
    !projectRepository ||
    !serviceRepository ||
    !workspaceMountRepository ||
    !researchProjectRepository
  ) {
    return undefined
  }
  const service = new ProjectService({
    projectRepository,
    serviceRepository,
    workspaceMountRepository,
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    projectKinds: sources.projectKinds,
    research: { definitions: sources.researchDefinitions, projects: researchProjectRepository },
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    events,
    logger: deps.logger,
  })
  const {
    researchDefinitionRepository,
    findingsRevisionRepository,
    findingsStoragePolicyRepository,
  } = deps
  const findings = findingsRevisionRepository
    ? createResearchFindingsStore(deps, findingsRevisionRepository)
    : undefined
  const getMounted = (workspaceId: string, projectId: string) =>
    service.getMounted(workspaceId, projectId)
  return {
    service,
    research: {
      projects: researchProjectRepository,
      definitions: sources.researchDefinitions,
      ...(researchDefinitionRepository
        ? {
            publisher: new ResearchDefinitionPublisher({
              registered: sources.registeredResearchDefinitions,
              repository: researchDefinitionRepository,
              clock: deps.clock,
            }),
          }
        : {}),
      ...(findings
        ? {
            findings,
            views: new ResearchProjectViews({
              getMounted,
              pins: researchProjectRepository,
              definitions: sources.researchDefinitions,
              findings,
              workspaceRepository: deps.workspaceRepository,
            }),
          }
        : {}),
      ...(findingsStoragePolicyRepository
        ? {
            storagePolicy: new FindingsStoragePolicyService({
              findingsStoragePolicyRepository,
              workspaceRepository: deps.workspaceRepository,
              assertProjectMounted: async (workspaceId, projectId) => {
                await getMounted(workspaceId, projectId)
              },
            }),
          }
        : {}),
    },
  }
}
