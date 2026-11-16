import type { Project, ProjectPin } from '@cat-factory/contracts'
import {
  ProjectDefinitionRegistry,
  ProjectKindRegistry,
  composeProjectDefinitionSource,
  registryProjectDefinitionSource,
  registryProjectKindSource,
  type BlockRepository,
  type ProjectRecordRepository,
  type ProjectRepository,
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
    id: 'plain',
    label: 'Plain',
    taskTypes: [{ taskType: 'spike', repoAccess: 'none' }],
  })
  registry.register({
    id: 'vendor-study',
    label: 'Vendor study',
    definition: 'required',
    taskTypes: [{ taskType: 'spike', repoAccess: 'none' }],
  })
  return registry
}

function definitions(): ProjectDefinitionRegistry {
  const registry = new ProjectDefinitionRegistry([
    { kind: 'vendor-study', parseSpec: (d) => ({ ok: true, value: d.spec }) },
  ])
  registry.register({
    kind: 'vendor-study',
    key: 'acme:vendor',
    version: 1,
    title: 'Vendor',
    spec: { brief: 'Learn how the vendor integrates.' },
  })
  return registry
}

function harness(failing: 'block' | 'mount' | 'none') {
  const projects = new Map<string, Project>()
  const blocks = new Set<string>()
  const mounts = new Map<string, WorkspaceMount>()
  const pins = new Map<string, ProjectPin>()
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
    definitions: composeProjectDefinitionSource({
      registered: registryProjectDefinitionSource(definitions()),
    }),
    records: {
      insertPin: async (p: ProjectPin) => void pins.set(p.projectId, p),
      deleteByProjects: async (ids: string[]) => ids.forEach((id) => pins.delete(id)),
    } as unknown as ProjectRecordRepository,
    idGenerator: { next: (prefix: string) => `${prefix}_${++next}` },
    clock: { now: () => 1 },
  })
  return { service, projects, blocks, mounts, pins }
}

const pinned = { kind: 'vendor-study', title: 'Q', serviceIds: [] }

describe('ProjectService.create', () => {
  it.each(['block', 'mount'] as const)(
    'leaves no project, root or mount behind when the %s write fails',
    async (failing) => {
      const { service, projects, blocks, mounts } = harness(failing)
      await expect(
        service.create('ws', { kind: 'plain', title: 'Q', serviceIds: [] }),
      ).rejects.toThrow(/failed/)
      expect(projects.size).toBe(0)
      expect(blocks.size).toBe(0)
      expect(mounts.size).toBe(0)
    },
  )

  it.each(['block', 'mount'] as const)(
    'leaves no pin behind when the %s write fails',
    async (failing) => {
      const { service, projects, pins } = harness(failing)
      await expect(
        service.create('ws', { ...pinned, definition: { key: 'acme:vendor', inputs: {} } }),
      ).rejects.toThrow(/failed/)
      expect(projects.size).toBe(0)
      expect(pins.size).toBe(0)
    },
  )

  it('pins the latest version of a definition of the project own kind', async () => {
    const { service, pins } = harness('none')
    const created = await service.create('ws', {
      ...pinned,
      definition: { key: 'acme:vendor', inputs: {} },
    })
    expect(pins.get(created.project.id)).toMatchObject({
      definitionKey: 'acme:vendor',
      definitionVersion: 1,
    })
  })

  it('refuses a missing definition, a definition the kind does not pin, and an unknown key', async () => {
    const { service } = harness('none')
    await expect(service.create('ws', pinned)).rejects.toMatchObject({
      details: { reason: 'project_definition_required' },
    })
    await expect(
      service.create('ws', {
        kind: 'plain',
        title: 'Q',
        serviceIds: [],
        definition: { key: 'acme:vendor', inputs: {} },
      }),
    ).rejects.toMatchObject({ details: { reason: 'project_definition_not_accepted' } })
    await expect(
      service.create('ws', { ...pinned, definition: { key: 'acme:other', inputs: {} } }),
    ).rejects.toMatchObject({ details: { reason: 'project_definition_not_found' } })
  })
})
