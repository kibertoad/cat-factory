import type { MountSubjectKind } from '@cat-factory/contracts'
import type { Block, WorkspaceMount } from './types.js'
import type { ProjectRepository } from '../ports/project-repositories.js'
import type { ServiceRepository } from '../ports/service-repositories.js'

// A board mounts SUBJECTS (services and projects). Each owns one root block: a service its
// `frame`, a project its `project` root. These two reads resolve between the two, one batched
// query per subject kind, so no reader branches on the kind or reads per mount.

export interface MountSubjectReaders {
  serviceRepository?: Pick<ServiceRepository, 'listByIds' | 'listByFrameBlocks'>
  projectRepository?: Pick<ProjectRepository, 'listByIds' | 'listByRootBlocks'>
}

export interface MountSubjectRoot {
  subjectKind: MountSubjectKind
  subjectId: string
  rootBlockId: string
  accountId: string | null
}

/** The root block of every mounted subject that still exists, keyed by subject id. */
export async function rootBlocksOfMounts(
  mounts: readonly Pick<WorkspaceMount, 'subjectKind' | 'subjectId'>[],
  readers: MountSubjectReaders,
): Promise<Map<string, string>> {
  const serviceIds = mounts.filter((m) => m.subjectKind === 'service').map((m) => m.subjectId)
  const projectIds = mounts.filter((m) => m.subjectKind === 'project').map((m) => m.subjectId)
  const [services, projects] = await Promise.all([
    serviceIds.length && readers.serviceRepository
      ? readers.serviceRepository.listByIds(serviceIds)
      : [],
    projectIds.length && readers.projectRepository
      ? readers.projectRepository.listByIds(projectIds)
      : [],
  ])
  const roots = new Map<string, string>()
  for (const service of services) roots.set(service.id, service.frameBlockId)
  for (const project of projects) roots.set(project.id, project.rootBlockId)
  return roots
}

/**
 * The subjects owning the given root blocks. A `frame` root can only be a service's and a `project`
 * root only a project's, so each kind is read for its own roots alone. A root id need not identify
 * one subject: seeded boards share block ids, so a caller narrows the answer further.
 */
export async function subjectsOwningRoots(
  roots: readonly Pick<Block, 'id' | 'level'>[],
  readers: MountSubjectReaders,
): Promise<MountSubjectRoot[]> {
  const frameIds = roots.filter((b) => b.level === 'frame').map((b) => b.id)
  const projectRootIds = roots.filter((b) => b.level === 'project').map((b) => b.id)
  const [services, projects] = await Promise.all([
    frameIds.length && readers.serviceRepository
      ? readers.serviceRepository.listByFrameBlocks(frameIds)
      : [],
    projectRootIds.length && readers.projectRepository
      ? readers.projectRepository.listByRootBlocks(projectRootIds)
      : [],
  ])
  return [
    ...services.map((s) => ({
      subjectKind: 'service' as const,
      subjectId: s.id,
      rootBlockId: s.frameBlockId,
      accountId: s.accountId,
    })),
    ...projects.map((p) => ({
      subjectKind: 'project' as const,
      subjectId: p.id,
      rootBlockId: p.rootBlockId,
      accountId: p.accountId,
    })),
  ]
}
