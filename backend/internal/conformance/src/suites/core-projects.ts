import type { Project } from '@cat-factory/contracts'
import type { Block, WorkspaceMount, WorkspaceSnapshot } from '@cat-factory/kernel'
import {
  ProjectKindModuleRegistry,
  ProjectKindRegistry,
  ProjectDefinitionRegistry,
  SIMPLE_PIPELINE_ID,
  projectDefinitionContentHash,
  type ProjectKindModule,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Projects: account-owned peers of services, mounted onto boards like a service and holding
// tasks under a `project` root. Pins the D1 and Postgres projects store, the generalized mount
// and owner stamp, task admission by the project's kind, and the workspace-delete re-home.

interface CreatedProject {
  project: Project
  rootBlock: Block
  mount: WorkspaceMount
}

function kinds(): ProjectKindRegistry {
  const registry = new ProjectKindRegistry()
  registry.register({
    id: 'research',
    label: 'Research',
    taskTypes: [
      { taskType: 'spike', repoAccess: 'linked-read-only', defaultPipelineId: SIMPLE_PIPELINE_ID },
    ],
  })
  registry.register({
    id: 'vendor-study',
    label: 'Vendor study',
    definition: 'required',
    taskTypes: [{ taskType: 'spike', repoAccess: 'none', defaultPipelineId: SIMPLE_PIPELINE_ID }],
  })
  return registry
}

function vendorDefinition(version: number) {
  return {
    kind: 'vendor-study',
    key: 'acme:vendor',
    version,
    title: 'Vendor',
    spec: { brief: 'Learn how the vendor integrates.' },
    inputs: [
      { key: 'region', label: 'Region', type: 'text' as const, required: true },
      {
        key: 'depth',
        label: 'Depth',
        type: 'select' as const,
        default: 'shallow',
        options: [
          { value: 'shallow', label: 'Shallow' },
          { value: 'deep', label: 'Deep' },
        ],
      },
      { key: 'notes', label: 'Notes', type: 'text' as const },
    ],
  }
}

// The kind's own spec is opaque here: the platform pins whatever the kind's module accepts, and
// lists a definition by the summary the module writes. Its tasks never run in this suite.
const vendorStudyModule: ProjectKindModule<unknown> = {
  kind: 'vendor-study',
  agentKind: 'vendor-studier',
  outcomeSchemaVersion: 1,
  parseSpec: (definition) => ({ ok: true, value: definition.spec }),
  parseOutcome: (_version, value) => value,
  planTask: () => ({ intent: 'study', stream: 'main', plan: {} }),
  brief: () => ({}),
  mergeCheckpoint: (_earlier, later) => later,
  finish: ({ reply }) => ({ body: reply, output: '' }),
  describe: () => '',
  artifactRefs: () => [],
  definitionSummary: (definition) => (definition.spec as { brief: string }).brief,
}

function modules(): ProjectKindModuleRegistry {
  const registry = new ProjectKindModuleRegistry()
  registry.register(vendorStudyModule)
  return registry
}

function definitions(): ProjectDefinitionRegistry {
  const registry = new ProjectDefinitionRegistry(modules().all())
  registry.registerAll([vendorDefinition(1), vendorDefinition(2)])
  return registry
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

export function defineCoreProjectsConformance(harness: ConformanceHarness): void {
  describe('projects', () => {
    async function setup() {
      const app = harness.makeApp(undefined, {
        projectKindRegistry: kinds(),
        projectKindModuleRegistry: modules(),
        projectDefinitionRegistry: definitions(),
      })
      const home = await app.createOrgWorkspace({ seed: true })
      const accountId = (await app.workspaceRepository().accountOf(home.workspace.id))!
      return { app, home, wsId: home.workspace.id, accountId }
    }

    async function createProject(
      app: Awaited<ReturnType<typeof setup>>['app'],
      wsId: string,
      body: Record<string, unknown> = {},
    ) {
      return app.call<CreatedProject>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Vendor research',
        position: { x: 640, y: 80 },
        ...body,
      })
    }

    it('creates a project whose root, mount and catalog entry the snapshot carries', async () => {
      const { app, wsId } = await setup()
      const created = await createProject(app, wsId)
      expect(created.status).toBe(201)
      expect(created.body.rootBlock).toMatchObject({ level: 'project', type: 'project' })
      expect(created.body.mount).toMatchObject({ subjectKind: 'project', workspaceId: wsId })

      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const root = snap.blocks.find((b) => b.id === created.body.project.rootBlockId)
      expect(root?.position).toEqual({ x: 640, y: 80 })
      expect(snap.mounts?.find((m) => m.subjectId === created.body.project.id)?.subjectKind).toBe(
        'project',
      )
      expect(snap.projectCatalog?.find((p) => p.id === created.body.project.id)?.mountCount).toBe(1)
      expect(snap.projectKinds?.map((k) => k.id)).toEqual(['research', 'vendor-study'])
      // A project root is not a service frame: the service catalog never lists it.
      expect(
        snap.serviceCatalog?.some((s) => s.frameBlockId === created.body.project.rootBlockId),
      ).toBe(false)
    })

    it('refuses an unregistered kind and a link to a service that does not exist', async () => {
      const { app, wsId } = await setup()
      const unknownKind = await createProject(app, wsId, { kind: 'unknown' })
      expect(unknownKind.status).toBe(422)
      expect(reasonOf(unknownKind.body)).toBe('project_kind_unregistered')
      const badLink = await createProject(app, wsId, { serviceIds: ['svc_missing'] })
      expect(badLink.status).toBe(422)
      expect(reasonOf(badLink.body)).toBe('project_service_link_invalid')
    })

    it("lists one kind's pinnable definition versions with their inputs and no spec", async () => {
      const { app, wsId } = await setup()
      const listed = await app.call<Array<Record<string, unknown>>>(
        'GET',
        `/workspaces/${wsId}/project-kinds/vendor-study/definitions`,
      )
      expect(listed.status).toBe(200)
      expect(listed.body).toEqual(
        [1, 2].map((version) => ({
          kind: 'vendor-study',
          key: 'acme:vendor',
          version,
          title: 'Vendor',
          summary: 'Learn how the vendor integrates.',
          inputs: vendorDefinition(version).inputs,
          origin: 'registered',
        })),
      )
      // A kind with no module of its own lists nothing rather than definitions it cannot pin.
      const other = await app.call<unknown[]>(
        'GET',
        `/workspaces/${wsId}/project-kinds/research-elsewhere/definitions`,
      )
      expect(other.body).toEqual([])
    })

    it('pins the definition a kind requires, with its hash and inputs', async () => {
      const { app, wsId } = await setup()
      const latest = await createProject(app, wsId, {
        kind: 'vendor-study',
        definition: { key: 'acme:vendor', inputs: { region: 'eu', notes: '' } },
      })
      expect(latest.status).toBe(201)
      const pinned = await app.projectRecordRepository().getPin(latest.body.project.id)
      expect(pinned).toMatchObject({
        definitionKey: 'acme:vendor',
        definitionVersion: 2,
        definitionHash: await projectDefinitionContentHash(
          definitions().get('vendor-study', 'acme:vendor', 2)!,
        ),
      })
      // The declared default answers an omitted field, and an unfilled one is not pinned.
      expect(pinned?.inputs).toEqual({ region: 'eu', depth: 'shallow' })
      const exact = await createProject(app, wsId, {
        kind: 'vendor-study',
        definition: { key: 'acme:vendor', version: 1, inputs: { region: 'us' } },
      })
      expect(exact.status).toBe(201)
      expect(
        (await app.projectRecordRepository().getPin(exact.body.project.id))?.definitionVersion,
      ).toBe(1)
    })

    it('refuses a definition that is missing, misplaced, unknown or under-filled', async () => {
      const { app, wsId } = await setup()
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ kind: 'vendor-study' }, 'project_definition_required'],
        [{ definition: { key: 'acme:vendor' } }, 'project_definition_not_accepted'],
        [
          {
            kind: 'vendor-study',
            definition: { key: 'acme:vendor', version: 9 },
          },
          'project_definition_not_found',
        ],
        [
          { kind: 'vendor-study', definition: { key: 'acme:vendor', inputs: {} } },
          'project_definition_inputs_invalid',
        ],
      ]
      for (const [body, reason] of cases) {
        const refused = await createProject(app, wsId, body)
        expect(refused.status).toBe(422)
        expect(reasonOf(refused.body)).toBe(reason)
      }
      // A refused create writes nothing.
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      expect(snap.projectCatalog ?? []).toEqual([])
    })

    it('links services of its own account and replaces the links', async () => {
      const { app, wsId } = await setup()
      const board = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const serviceIds = (board.serviceCatalog ?? []).map((s) => s.id).slice(0, 2)
      expect(serviceIds.length).toBe(2)
      const created = await createProject(app, wsId, { serviceIds })
      expect(created.body.project.serviceIds).toEqual(serviceIds)
      const relinked = await app.call<Project>(
        'PUT',
        `/workspaces/${wsId}/projects/${created.body.project.id}/services`,
        { serviceIds: [serviceIds[1]] },
      )
      expect(relinked.status).toBe(200)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      expect(
        snap.projectCatalog?.find((p) => p.id === created.body.project.id)?.serviceIds,
      ).toEqual([serviceIds[1]])
    })

    it("admits only the task types the project's kind offers, with the kind's default pipeline", async () => {
      const { app, wsId } = await setup()
      const { project } = (await createProject(app, wsId)).body
      const spike = await app.call<Block>(
        'POST',
        `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`,
        { title: 'Map the auth flow', taskType: 'spike' },
      )
      expect(spike.status).toBe(201)
      expect(spike.body).toMatchObject({ type: 'project', pipelineId: SIMPLE_PIPELINE_ID })
      const feature = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`,
        { title: 'Build it', taskType: 'feature' },
      )
      expect(feature.status).toBe(422)
      expect(reasonOf(feature.body)).toBe('task_type_not_offered_by_project')
    })

    it('mounts on a second board of the account, laid out per board, tasks shared', async () => {
      const { app, wsId, accountId } = await setup()
      const { project } = (await createProject(app, wsId)).body
      await app.call('POST', `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`, {
        title: 'Shared question',
        taskType: 'spike',
      })
      const other = await app.createWorkspaceInAccount(accountId, null, { name: 'Other board' })
      const mounted = await app.call<WorkspaceMount>(
        'POST',
        `/workspaces/${other.workspace.id}/projects/${project.id}/mount`,
        { position: { x: 20, y: 30 } },
      )
      expect(mounted.status).toBe(201)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${other.workspace.id}`))
        .body
      expect(snap.blocks.find((b) => b.id === project.rootBlockId)?.position).toEqual({
        x: 20,
        y: 30,
      })
      expect(snap.blocks.some((b) => b.title === 'Shared question')).toBe(true)
      expect(snap.projectCatalog?.find((p) => p.id === project.id)?.mountCount).toBe(2)
    })

    it('survives its home board being deleted when another board mounts it', async () => {
      const { app, wsId, accountId } = await setup()
      const { project } = (await createProject(app, wsId)).body
      const other = await app.createWorkspaceInAccount(accountId, null, { name: 'Other board' })
      await app.call('POST', `/workspaces/${other.workspace.id}/projects/${project.id}/mount`, {})
      expect((await app.call('DELETE', `/workspaces/${wsId}`)).status).toBe(204)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${other.workspace.id}`))
        .body
      expect(snap.blocks.some((b) => b.id === project.rootBlockId)).toBe(true)
      expect(snap.projectCatalog?.map((p) => p.id)).toContain(project.id)
    })

    it('re-homes a shared service its home board has unmounted', async () => {
      const { app, wsId, accountId } = await setup()
      const frame = (
        await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'service',
          title: 'Shared service',
        })
      ).body
      const before = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const service = before.serviceCatalog?.find((s) => s.frameBlockId === frame.id)
      expect(service).toBeTruthy()
      const other = await app.createWorkspaceInAccount(accountId, null, { name: 'Other board' })
      await app.call('POST', `/workspaces/${other.workspace.id}/services/${service!.id}`, {})
      expect((await app.call('DELETE', `/workspaces/${wsId}/services/${service!.id}`)).status).toBe(
        204,
      )
      expect((await app.call('DELETE', `/workspaces/${wsId}`)).status).toBe(204)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${other.workspace.id}`))
        .body
      expect(snap.blocks.some((b) => b.id === frame.id)).toBe(true)
      expect(snap.serviceCatalog?.map((s) => s.id)).toContain(service!.id)
    })

    it("refuses to unmount a project through the service route, keeping its home board's mount", async () => {
      const { app, wsId } = await setup()
      const { project } = (await createProject(app, wsId)).body
      const refused = await app.call('DELETE', `/workspaces/${wsId}/services/${project.id}`)
      expect(refused.status).toBe(404)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      expect(snap.mounts?.some((m) => m.subjectId === project.id)).toBe(true)
    })

    it('reclaims an unshared project with its home board', async () => {
      const { app, wsId, accountId } = await setup()
      const { project } = (await createProject(app, wsId)).body
      const other = await app.createWorkspaceInAccount(accountId, null, { name: 'Other board' })
      expect((await app.call('DELETE', `/workspaces/${wsId}`)).status).toBe(204)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${other.workspace.id}`))
        .body
      expect(snap.projectCatalog?.map((p) => p.id) ?? []).not.toContain(project.id)
    })

    it('refuses deleting a project with unfinished tasks, and reclaims it once it has none', async () => {
      const { app, wsId } = await setup()
      const { project } = (await createProject(app, wsId)).body
      const task = (
        await app.call<Block>('POST', `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`, {
          title: 'Open question',
          taskType: 'spike',
        })
      ).body
      const refused = await app.call('DELETE', `/workspaces/${wsId}/blocks/${project.rootBlockId}`)
      expect(refused.status).toBe(422)
      expect(reasonOf(refused.body)).toBe('project_has_unfinished_tasks')
      await app.call('DELETE', `/workspaces/${wsId}/blocks/${task.id}`)
      await app.call('DELETE', `/workspaces/${wsId}/blocks/${project.rootBlockId}`)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      expect(snap.projectCatalog?.map((p) => p.id) ?? []).not.toContain(project.id)
      expect(snap.mounts?.some((m) => m.subjectId === project.id)).toBe(false)
    })

    it('drops a deleted service from every project linking it', async () => {
      const { app, wsId } = await setup()
      const frame = (
        await app.call<Block>('POST', `/workspaces/${wsId}/blocks`, {
          type: 'service',
          title: 'Short-lived service',
        })
      ).body
      const before = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const service = before.serviceCatalog?.find((s) => s.frameBlockId === frame.id)
      expect(service).toBeTruthy()
      const { project } = (await createProject(app, wsId, { serviceIds: [service!.id] })).body
      await app.call('DELETE', `/workspaces/${wsId}/blocks/${frame.id}`)
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      expect(snap.projectCatalog?.find((p) => p.id === project.id)?.serviceIds).toEqual([])
    })
  })
}
