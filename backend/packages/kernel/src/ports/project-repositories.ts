import type { Project } from '@cat-factory/contracts'

/** Persistence for account-owned projects and their service links. */
export interface ProjectRepository {
  get(id: string): Promise<Project | null>
  /** Projects by id, in a single (chunked) query. Empty input gives an empty result. */
  listByIds(ids: string[]): Promise<Project[]>
  /** Every project owned by an account (the catalog a board mounts from). */
  listByAccount(accountId: string | null): Promise<Project[]>
  /** The projects owning the given root blocks, in a single (chunked) query. */
  listByRootBlocks(rootBlockIds: string[]): Promise<Project[]>
  /** Insert a project with its service links. */
  insert(project: Project): Promise<void>
  /** Replace a project's service links. */
  setServiceLinks(projectId: string, serviceIds: string[]): Promise<void>
  /** Drop every link to the given services, when those services are deleted. */
  unlinkServices(serviceIds: string[]): Promise<void>
  /** Delete projects and their links in a single (chunked) pass. Empty input is a no-op. */
  deleteMany(ids: string[]): Promise<void>
}

/** A project linked to a task as read-only context. */
export interface TaskProjectLink {
  workspaceId: string
  blockId: string
  projectId: string
  createdAt: number
}

/** Persistence for the projects linked to tasks as context. */
export interface TaskProjectLinkRepository {
  /** The projects linked to a block, oldest link first. */
  listByBlock(workspaceId: string, blockId: string): Promise<TaskProjectLink[]>
  /** Link projects to a block. Linking a project already linked keeps the first link. */
  link(workspaceId: string, blockId: string, projectIds: string[], createdAt: number): Promise<void>
  unlink(workspaceId: string, blockId: string, projectId: string): Promise<void>
  /** Drop every link of the given blocks, when they are deleted. Empty input is a no-op. */
  deleteByBlocks(workspaceId: string, blockIds: string[]): Promise<void>
  /** Drop every link to the given projects, when they are reclaimed. Empty input is a no-op. */
  deleteByProjects(projectIds: string[]): Promise<void>
}
