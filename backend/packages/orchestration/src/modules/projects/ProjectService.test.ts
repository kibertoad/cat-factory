import type { Project, ResearchProject } from '@cat-factory/contracts'
import {
  ProjectKindRegistry,
  ResearchDefinitionRegistry,
  composeResearchDefinitionSource,
  registryProjectKindSource,
  registryResearchDefinitionSource,
  type BlockRepository,
  type ProjectRepository,
  type ResearchProjectRepository,
  type ServiceRepository,
  type WorkspaceMount,
  type WorkspaceMountRepository,
  type WorkspaceRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ProjectService } from './ProjectService.js'

function kinds(): ProjectKindRegistry {
  const registry = new ProjectKindRegistry()
  registry.register({
    id: 'research',
    label: 'Research',
    taskTypes: [{ taskType: 'spike', repoAccess: 'none' }],
  })
  registry.register({
    id: 'vendor-study',
    label: 'Vendor study',
    data: 'research',
    taskTypes: [{ taskType: 'spike', repoAccess: 'none' }],
  })
  return registry
}

function definitions(): ResearchDefinitionRegistry {
  const registry = new ResearchDefinitionRegistry()
  registry.register({
    key: 'acme:vendor',
    version: 1,
    title: 'Vendor',
    brief: 'Learn how the vendor integrates.',
    topics: [{ id: 'auth', title: 'Auth', questions: [{ id: 'scheme', question: 'Which?' }] }],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'api' }],
  })
  return registry
}

function harness(failing: 'block' | 'mount') {
  const projects = new Map<string, Project>()
  const blocks = new Set<string>()
  const mounts = new Map<string, WorkspaceMount>()
  const pins = new Map<string, ResearchProject>()
  let next = 0
  const service = new ProjectService({
    projectRepository: {
      insert: async (p: Project) => void projects.set(p.id, p),
      deleteMany: async (ids: string[]) => ids.forEach((id) => projects.delete(id)),
    } as unknown as ProjectRepository,
    blockRepository: {
      insert: async (_ws: string, block: { id: string }) => {
        if (failing === 'block') throw new Error('block insert failed')
        blocks.add(block.id)
      },
      deleteMany: async (_ws: string, ids: string[]) => ids.forEach((id) => blocks.delete(id)),
    } as unknown as BlockRepository,
    workspaceMountRepository: {
      listByWorkspace: async () => [],
      upsert: async (m: WorkspaceMount) => {
        if (failing === 'mount') throw new Error('mount upsert failed')
        mounts.set(m.subjectId, m)
      },
      remove: async (_ws: string, subjectId: string) => void mounts.delete(subjectId),
    } as unknown as WorkspaceMountRepository,
    workspaceRepository: {
      get: async (id: string) => ({ id, name: id }),
      accountOf: async () => 'acc',
    } as unknown as WorkspaceRepository,
    serviceRepository: {} as ServiceRepository,
    projectKinds: registryProjectKindSource(kinds()),
    research: {
      definitions: composeResearchDefinitionSource({
        registered: registryResearchDefinitionSource(definitions()),
      }),
      projects: {
        insert: async (p: ResearchProject) => void pins.set(p.projectId, p),
        deleteMany: async (ids: string[]) => ids.forEach((id) => pins.delete(id)),
      } as unknown as ResearchProjectRepository,
    },
    idGenerator: { next: (prefix: string) => `${prefix}_${++next}` },
    clock: { now: () => 1 },
  })
  return { service, projects, blocks, mounts, pins }
}

describe('ProjectService.create', () => {
  it.each(['block', 'mount'] as const)(
    'leaves no project, root or mount behind when the %s write fails',
    async (failing) => {
      const { service, projects, blocks, mounts } = harness(failing)
      await expect(
        service.create('ws', { kind: 'research', title: 'Q', serviceIds: [] }),
      ).rejects.toThrow(/failed/)
      expect(projects.size).toBe(0)
      expect(blocks.size).toBe(0)
      expect(mounts.size).toBe(0)
    },
  )

  it.each(['block', 'mount'] as const)(
    'leaves no research pin behind when the %s write fails',
    async (failing) => {
      const { service, projects, pins } = harness(failing)
      await expect(
        service.create('ws', {
          kind: 'vendor-study',
          title: 'Q',
          serviceIds: [],
          research: { definitionKey: 'acme:vendor', inputs: {} },
        }),
      ).rejects.toThrow(/failed/)
      expect(projects.size).toBe(0)
      expect(pins.size).toBe(0)
    },
  )
})
