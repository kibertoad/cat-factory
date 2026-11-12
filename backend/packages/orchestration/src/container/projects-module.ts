import type {
  ExecutionEventPublisher,
  ProjectDefinitionSource,
  ProjectKindModuleRegistry,
  ProjectKindSource,
  RegisteredProjectDefinitionSource,
} from '@cat-factory/kernel'
import type { ProjectsModule } from '../container.js'
import { ProjectDefinitionPublisher } from '../modules/projects/ProjectDefinitionPublisher.js'
import { ProjectOutcomeReader } from '../modules/projects/ProjectOutcomeReader.js'
import { ProjectService } from '../modules/projects/ProjectService.js'
import { createProjectOutcomeStore } from '../modules/projects/createProjectStepController.js'
import type { CoreDependencies } from './dependencies.js'

/** Assemble the projects module when the project, service and mount repositories are wired. */
export function createProjectsModule(
  deps: CoreDependencies,
  sources: {
    projectKinds: ProjectKindSource
    projectDefinitions: ProjectDefinitionSource
    registeredProjectDefinitions: RegisteredProjectDefinitionSource
    projectKindModules: ProjectKindModuleRegistry
  },
  events: ExecutionEventPublisher,
): ProjectsModule | undefined {
  const {
    projectRepository,
    serviceRepository,
    workspaceMountRepository,
    projectRecordRepository,
  } = deps
  if (
    !projectRepository ||
    !serviceRepository ||
    !workspaceMountRepository ||
    !projectRecordRepository
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
    definitions: sources.projectDefinitions,
    records: projectRecordRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    events,
    logger: deps.logger,
  })
  const { projectDefinitionRepository } = deps
  return {
    service,
    records: projectRecordRepository,
    definitions: sources.projectDefinitions,
    modules: sources.projectKindModules,
    outcomes: new ProjectOutcomeReader({
      records: projectRecordRepository,
      outcomes: createProjectOutcomeStore(deps, projectRecordRepository),
      definitions: sources.projectDefinitions,
      modules: sources.projectKindModules,
    }),
    ...(projectDefinitionRepository
      ? {
          publisher: new ProjectDefinitionPublisher({
            registered: sources.registeredProjectDefinitions,
            repository: projectDefinitionRepository,
            modules: sources.projectKindModules,
            clock: deps.clock,
          }),
        }
      : {}),
  }
}
