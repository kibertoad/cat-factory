import type { Project, ProjectKindData, TaskLinkedProject } from '@cat-factory/contracts'
import {
  type AgentRunContext,
  type BlockRepository,
  type Clock,
  type ProjectKindSource,
  type ProjectRepository,
  type TaskProjectLinkRepository,
  type WorkspaceRepository,
  NotFoundError,
  ValidationError,
} from '@cat-factory/kernel'
import type { ProjectContextContributors } from './projectContext.js'

export interface TaskProjectLinkServiceDeps {
  links: TaskProjectLinkRepository
  projectRepository: Pick<ProjectRepository, 'listByIds'>
  blockRepository: Pick<BlockRepository, 'get' | 'findByIds'>
  workspaceRepository: Pick<WorkspaceRepository, 'accountOf'>
  projectKinds: ProjectKindSource
  contributors: ProjectContextContributors
  clock: Clock
}

export type ContextProject = NonNullable<AgentRunContext['block']['contextProjects']>[number]

/**
 * Projects linked to tasks as read-only context. A link is admitted only for a project of the
 * task's own account that has a result to read, and at dispatch every linked project's current
 * result is rendered by its kind. A linked project with no readable result breaks the run rather
 * than reaching the agent as nothing.
 */
export class TaskProjectLinkService {
  constructor(private readonly deps: TaskProjectLinkServiceDeps) {}

  async list(workspaceId: string, blockId: string): Promise<TaskLinkedProject[]> {
    await this.requireTask(workspaceId, blockId)
    const links = await this.deps.links.listByBlock(workspaceId, blockId)
    const projects = await this.projectsById(links.map((l) => l.projectId))
    const titles = await this.titlesOf([...projects.values()])
    return links.flatMap((link) => {
      const project = projects.get(link.projectId)
      if (!project) return []
      return [
        {
          projectId: project.id,
          kind: project.kind,
          title: titles.get(project.id) ?? null,
          linkedAt: link.createdAt,
        },
      ]
    })
  }

  async link(
    workspaceId: string,
    blockId: string,
    projectIds: string[],
  ): Promise<TaskLinkedProject[]> {
    await this.requireTask(workspaceId, blockId)
    await this.assertLinkable(workspaceId, projectIds)
    await this.deps.links.link(workspaceId, blockId, projectIds, this.deps.clock.now())
    return this.list(workspaceId, blockId)
  }

  /** Unlink one project. Idempotent; the project itself is untouched. */
  async unlink(workspaceId: string, blockId: string, projectId: string): Promise<void> {
    await this.requireTask(workspaceId, blockId)
    await this.deps.links.unlink(workspaceId, blockId, projectId)
  }

  /** Drop every link a task holds, when the task is rolled back before it ever ran. */
  async unlinkAll(workspaceId: string, blockId: string): Promise<void> {
    await this.deps.links.deleteByBlocks(workspaceId, [blockId])
  }

  /**
   * Refuse projects that do not exist or belong to another account (`project_link_invalid`), and
   * projects with no result to read yet (`project_has_no_result`). Shared by the board, the public
   * API and an initiative's spawned tasks, so all three admit the same links.
   */
  async assertLinkable(workspaceId: string, projectIds: readonly string[]): Promise<void> {
    if (projectIds.length === 0) return
    const accountId = (await this.deps.workspaceRepository.accountOf(workspaceId)) ?? null
    const projects = await this.projectsById([...projectIds])
    const invalid = projectIds.filter(
      (id) => (projects.get(id)?.accountId ?? undefined) !== accountId,
    )
    if (invalid.length) {
      throw new ValidationError('A task can only link projects of its own organization', {
        reason: 'project_link_invalid',
        projectIds: invalid,
      })
    }
    const withResult = await this.withResult([...projects.values()])
    const empty = projectIds.filter((id) => !withResult.has(id))
    if (empty.length) {
      throw new ValidationError('A linked project has no result to read yet', {
        reason: 'project_has_no_result',
        projectIds: empty,
      })
    }
  }

  /**
   * Every linked project's current result, rendered by its kind, in link order. Throws when a
   * linked project cannot be read: an unreadable body propagates its own refusal, and a project
   * with no result left refuses with `project_has_no_result`.
   */
  async resolveForDispatch(workspaceId: string, blockId: string): Promise<ContextProject[]> {
    const links = await this.deps.links.listByBlock(workspaceId, blockId)
    if (links.length === 0) return []
    const projects = await this.projectsById(links.map((l) => l.projectId))
    const ordered = links.flatMap((l) => {
      const project = projects.get(l.projectId)
      return project ? [project] : []
    })
    const [byData, titles] = await Promise.all([this.groupByData(ordered), this.titlesOf(ordered)])
    const rendered = new Map<string, Omit<ContextProject, 'projectId' | 'title' | 'kind'>>()
    for (const [data, group] of byData) {
      for (const [id, entry] of await this.deps.contributors[data].render(group))
        rendered.set(id, entry)
    }
    const missing = links.map((l) => l.projectId).filter((id) => !rendered.has(id))
    if (missing.length) {
      throw new ValidationError('A linked project has no result to read', {
        reason: 'project_has_no_result',
        projectIds: missing,
      })
    }
    return ordered.map((project) => ({
      projectId: project.id,
      title: titles.get(project.id) ?? project.id,
      kind: project.kind,
      ...rendered.get(project.id)!,
    }))
  }

  private async withResult(projects: readonly Project[]): Promise<Set<string>> {
    const found = new Set<string>()
    for (const [data, group] of await this.groupByData(projects)) {
      for (const id of await this.deps.contributors[data].withResult(group)) found.add(id)
    }
    return found
  }

  /** The projects grouped by the data their kind keeps; a kind keeping none contributes nothing. */
  private async groupByData(
    projects: readonly Project[],
  ): Promise<Map<ProjectKindData, Project[]>> {
    const kinds = new Map((await this.deps.projectKinds.all()).map((k) => [k.id, k] as const))
    const groups = new Map<ProjectKindData, Project[]>()
    for (const project of projects) {
      const data = kinds.get(project.kind)?.data
      if (data) groups.set(data, [...(groups.get(data) ?? []), project])
    }
    return groups
  }

  private async projectsById(ids: string[]): Promise<Map<string, Project>> {
    if (ids.length === 0) return new Map()
    return new Map(
      (await this.deps.projectRepository.listByIds(ids)).map((p) => [p.id, p] as const),
    )
  }

  /** Each project's title, which lives on its root block. */
  private async titlesOf(projects: readonly Project[]): Promise<Map<string, string>> {
    if (projects.length === 0) return new Map()
    const roots = await this.deps.blockRepository.findByIds(projects.map((p) => p.rootBlockId))
    const byRoot = new Map(roots.map((r) => [r.block.id, r.block.title] as const))
    return new Map(
      projects.flatMap((p) =>
        byRoot.has(p.rootBlockId) ? [[p.id, byRoot.get(p.rootBlockId)!]] : [],
      ),
    )
  }

  private async requireTask(workspaceId: string, blockId: string): Promise<void> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block || block.level !== 'task' || block.internal) throw new NotFoundError('Task', blockId)
  }
}
