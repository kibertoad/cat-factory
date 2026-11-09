import type { Project, TaskType } from '@cat-factory/contracts'
import {
  type Block,
  type ProjectKindSource,
  type ProjectRepository,
  NotFoundError,
  ValidationError,
  projectKindTaskType,
} from '@cat-factory/kernel'

export interface ProjectTaskAdmissionDeps {
  projectRepository?: Pick<ProjectRepository, 'listByRootBlocks'>
  projectKinds?: ProjectKindSource
}

export interface AdmittedProjectTask {
  project: Project
  /** The pipeline a task of this type starts with when the creator picked none. */
  defaultPipelineId?: string
}

/**
 * Which task types a project accepts, decided by its registered kind. Shared by task creation
 * and reparenting, so both doors answer alike.
 */
export function createProjectTaskAdmission(deps: ProjectTaskAdmissionDeps) {
  /** The project owning a `project` root block. */
  async function projectOfRoot(root: Block): Promise<Project> {
    const [project] = deps.projectRepository
      ? await deps.projectRepository.listByRootBlocks([root.id])
      : []
    if (!project) throw new NotFoundError('Project', root.id)
    return project
  }

  async function admit(root: Block, taskType: TaskType): Promise<AdmittedProjectTask> {
    const project = await projectOfRoot(root)
    const kind = deps.projectKinds ? await deps.projectKinds.get(project.kind) : undefined
    if (!kind) {
      throw new ValidationError(`Project kind '${project.kind}' is no longer registered`, {
        reason: 'project_kind_unregistered',
        kind: project.kind,
      })
    }
    const entry = projectKindTaskType(kind, taskType)
    if (!entry) {
      throw new ValidationError(`A ${kind.label} project does not take '${taskType}' tasks`, {
        reason: 'task_type_not_offered_by_project',
        taskType,
        kind: kind.id,
      })
    }
    return {
      project,
      ...(entry.defaultPipelineId ? { defaultPipelineId: entry.defaultPipelineId } : {}),
    }
  }

  return { admit, projectOfRoot }
}
