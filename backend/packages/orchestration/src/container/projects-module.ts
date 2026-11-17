import type {
  ExecutionEventPublisher,
  ProjectDefinitionSource,
  ProjectKindModuleRegistry,
  ProjectKindSource,
  RegisteredProjectDefinitionSource,
} from '@cat-factory/kernel'
import type { ProjectsModule } from '../container.js'
import { OutcomeStoragePolicyService } from '../modules/projects/OutcomeStoragePolicyService.js'
import { ProjectBoardViews } from '../modules/projects/ProjectBoardViews.js'
import { ProjectDefinitionPublisher } from '../modules/projects/ProjectDefinitionPublisher.js'
import { ProjectOutcomeReader } from '../modules/projects/ProjectOutcomeReader.js'
import { ProjectService } from '../modules/projects/ProjectService.js'
import {
  ProjectStageService,
  type StageRunStarter,
  type StageTaskBoard,
} from '../modules/projects/ProjectStageService.js'
import { TaskProjectLinkService } from '../modules/projects/TaskProjectLinkService.js'
import { projectContextContributor } from '../modules/projects/projectContext.js'
import { createBlockHomes } from '../modules/board/blockHomes.js'
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
  /**
   * Late-bound: the board and the engine are built after this module; a stage creates its tasks on
   * the board and starts an automatic stage's run through the engine.
   */
  late: {
    board: () => StageTaskBoard | undefined
    runStarter: () => StageRunStarter | undefined
  },
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
  // Assigned below: the stages read projects through the service, and a new project starts its
  // automatic stages through the stages.
  let stagesRef: ProjectStageService | undefined
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
    onCreated: async (workspaceId, projectId) => {
      await stagesRef?.advance(workspaceId, projectId)
    },
  })
  const { projectDefinitionRepository, outcomeStoragePolicyRepository, taskProjectLinkRepository } =
    deps
  const outcomes = createProjectOutcomeStore(deps, projectRecordRepository)
  const getMounted = (workspaceId: string, projectId: string) =>
    service.getMounted(workspaceId, projectId)
  const stages = new ProjectStageService({
    getMounted,
    listTasks: (project) => service.listTasks(project),
    records: projectRecordRepository,
    outcomes,
    modules: sources.projectKindModules,
    definitions: sources.projectDefinitions,
    board: late.board,
    runStarter: late.runStarter,
    clock: deps.clock,
    logger: deps.logger,
  })
  stagesRef = stages
  return {
    stages,
    service,
    records: projectRecordRepository,
    definitions: sources.projectDefinitions,
    modules: sources.projectKindModules,
    outcomes: new ProjectOutcomeReader({
      records: projectRecordRepository,
      outcomes,
      definitions: sources.projectDefinitions,
      modules: sources.projectKindModules,
    }),
    views: new ProjectBoardViews({
      getMounted,
      stages,
      records: projectRecordRepository,
      definitions: sources.projectDefinitions,
      outcomes,
      modules: sources.projectKindModules,
    }),
    ...(outcomeStoragePolicyRepository
      ? {
          storagePolicy: new OutcomeStoragePolicyService({
            outcomeStoragePolicyRepository,
            workspaceRepository: deps.workspaceRepository,
            assertProjectMounted: async (workspaceId, projectId) => {
              await getMounted(workspaceId, projectId)
            },
          }),
        }
      : {}),
    ...(taskProjectLinkRepository
      ? {
          taskLinks: new TaskProjectLinkService({
            links: taskProjectLinkRepository,
            projectRepository,
            blockRepository: deps.blockRepository,
            resolveBlock: createBlockHomes({
              blockRepository: deps.blockRepository,
              ...(deps.workspaceMountRepository
                ? { workspaceMountRepository: deps.workspaceMountRepository }
                : {}),
            }).resolveBlock,
            workspaceRepository: deps.workspaceRepository,
            context: projectContextContributor({
              records: projectRecordRepository,
              outcomes,
              definitions: sources.projectDefinitions,
              modules: sources.projectKindModules,
            }),
            clock: deps.clock,
          }),
        }
      : {}),
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
