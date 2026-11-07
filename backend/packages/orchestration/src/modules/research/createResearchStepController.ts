import type { ResearchDefinitionSource } from '@cat-factory/kernel'
import type { CoreDependencies } from '../../container/dependencies.js'
import { ResearchStepController } from './ResearchStepController.js'

/**
 * The research step's engine half, when the facade wires research persistence and projects.
 * Absent otherwise, and then the `project-researcher` step resolves no brief.
 */
export function createResearchStepController(
  deps: CoreDependencies,
  researchDefinitions: ResearchDefinitionSource,
): ResearchStepController | undefined {
  const { projectRepository, researchProjectRepository, findingsRevisionRepository } = deps
  if (!projectRepository || !researchProjectRepository || !findingsRevisionRepository) {
    return undefined
  }
  return new ResearchStepController({
    blockRepository: deps.blockRepository,
    projectRepository,
    ...(deps.serviceRepository ? { serviceRepository: deps.serviceRepository } : {}),
    workspaceRepository: deps.workspaceRepository,
    researchDefinitions,
    researchProjectRepository,
    findingsRevisionRepository,
    ...(deps.findingsStoragePolicyRepository
      ? { findingsStoragePolicyRepository: deps.findingsStoragePolicyRepository }
      : {}),
    clock: deps.clock,
  })
}
