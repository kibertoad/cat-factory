import type {
  PublicProject,
  PublicProjectFindings,
  PublicProjectTask,
  PublicResearchDefinitionList,
} from '@cat-factory/contracts'
import { ResearchDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { FakeAgentOptions } from '../FakeAgentExecutor.js'
import type { ConformanceHarness } from '../harness.js'
import { mintPublicApiKey } from './shared.js'

// Cross-runtime conformance for the public PROJECTS surface: research definitions published
// through the API, projects and their links, the tasks under a project, a research project's
// findings, and the credential resume. Facade-run because only a facade shows that each route is
// MOUNTED and that its writes land in its own store.

function definitions(): ResearchDefinitionRegistry {
  const registry = new ResearchDefinitionRegistry()
  registry.register({
    key: 'platform:vendor',
    version: 1,
    title: 'Vendor',
    brief: 'Learn how the vendor integrates.',
    topics: [
      {
        id: 'auth',
        title: 'Auth',
        questions: [
          { id: 'scheme', question: 'Which auth scheme?' },
          { id: 'scopes', question: 'Which scopes exist?' },
        ],
      },
    ],
    credentials: [
      {
        key: 'VENDOR_LOGIN',
        kind: 'login',
        label: 'Vendor login',
        requiredAtStart: false,
      },
    ],
    targets: [{ baseUrl: 'https://vendor.example', surface: 'ui' }],
  })
  return registry
}

function reasonOf(body: unknown): unknown {
  return (body as { error?: { details?: { reason?: unknown } } }).error?.details?.reason
}

const publishedBody = {
  title: 'CRM',
  brief: 'Learn how the CRM exposes contacts.',
  topics: [
    { id: 'api', title: 'API', questions: [{ id: 'paging', question: 'How does it page?' }] },
  ],
  targets: [{ baseUrl: 'https://crm.example', surface: 'api' }],
}

export function definePublicProjectsConformance(harness: ConformanceHarness): void {
  describe('public API: projects', () => {
    async function setup(agentOptions: FakeAgentOptions = {}) {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'], ...agentOptions },
        { researchDefinitionRegistry: definitions() },
      )
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const accountId = (await app.workspaceRepository().accountOf(workspace.id))!
      const write = await mintPublicApiKey(app, workspace.id, 'write', 'projects')
      const decide = await mintPublicApiKey(app, workspace.id, 'decide', 'projects')
      return { app, wsId: workspace.id, accountId, write, decide }
    }

    async function createResearchProject(
      app: Awaited<ReturnType<typeof setup>>['app'],
      key: Record<string, string>,
    ) {
      const created = await app.call<PublicProject>(
        'POST',
        '/api/v1/projects',
        {
          kind: 'research',
          title: 'Vendor research',
          research: { definitionKey: 'platform:vendor' },
        },
        key,
      )
      expect(created.status).toBe(201)
      return created.body
    }

    it('publishes an immutable definition version and lists it beside the registered ones', async () => {
      const { app, wsId } = await setup()
      const admin = await mintPublicApiKey(app, wsId, 'admin', 'definitions')
      const path = '/api/v1/research-definitions/acme:crm/versions/1'
      const published = await app.call('PUT', path, publishedBody, admin)
      expect(published.status).toBe(201)
      const again = await app.call('PUT', path, publishedBody, admin)
      expect(again.status).toBe(409)
      expect(reasonOf(again.body)).toBe('research_definition_version_exists')
      const squatting = await app.call(
        'PUT',
        '/api/v1/research-definitions/platform:crm/versions/1',
        publishedBody,
        admin,
      )
      expect(squatting.status).toBe(409)
      expect(reasonOf(squatting.body)).toBe('research_definition_key_registered')
      const reserved = await app.call(
        'PUT',
        '/api/v1/research-definitions/acme:crm/versions/2',
        {
          ...publishedBody,
          credentials: [
            { key: 'DATABASE_URL', kind: 'secret', label: 'Database', requiredAtStart: true },
          ],
        },
        admin,
      )
      // A reserved key never reaches the store: the credential key schema refuses it.
      expect(reserved.status).toBe(400)

      const listed = await app.call<PublicResearchDefinitionList>(
        'GET',
        '/api/v1/research-definitions',
        undefined,
        admin,
      )
      expect(
        listed.body.definitions.map(
          (d) => `${d.origin}:${d.definition.key}@${d.definition.version}`,
        ),
      ).toEqual(['registered:platform:vendor@1', 'stored:acme:crm@1'])
    })

    it('creates a research project, links services and serves it on a board that mounts it', async () => {
      const { app, accountId, write } = await setup()
      const project = await createResearchProject(app, write)
      expect(project).toMatchObject({
        kind: 'research',
        title: 'Vendor research',
        homedHere: true,
        research: { definitionKey: 'platform:vendor', definitionVersion: 1 },
      })
      const services = await app.call<{ services: { serviceId: string }[] }>(
        'GET',
        '/api/v1/services',
        undefined,
        write,
      )
      const serviceIds = services.body.services.map((s) => s.serviceId).slice(0, 2)
      const linked = await app.call<PublicProject>(
        'POST',
        `/api/v1/projects/${project.projectId}/services`,
        { serviceIds },
        write,
      )
      expect(linked.status, JSON.stringify(linked.body)).toBe(200)
      expect(linked.body.serviceIds.sort()).toEqual([...serviceIds].sort())
      const unlinked = await app.call<PublicProject>(
        'POST',
        `/api/v1/projects/${project.projectId}/services/unlink`,
        { serviceIds: [serviceIds[0]] },
        write,
      )
      expect(unlinked.body.serviceIds).toEqual([serviceIds[1]])

      const other = await app.createWorkspaceInAccount(accountId, null, { name: 'Other board' })
      const otherKey = await mintPublicApiKey(app, other.workspace.id, 'write', 'other')
      const mounted = await app.call<PublicProject>(
        'POST',
        `/api/v1/projects/${project.projectId}/mount`,
        undefined,
        otherKey,
      )
      expect(mounted.status).toBe(200)
      expect(mounted.body.homedHere).toBe(false)
      const listed = await app.call<{ projects: PublicProject[] }>(
        'GET',
        '/api/v1/projects',
        undefined,
        otherKey,
      )
      expect(listed.status, JSON.stringify(listed.body)).toBe(200)
      expect(listed.body.projects.map((p) => p.projectId)).toEqual([project.projectId])
      // Only the board that homes a project creates and runs its tasks.
      const refused = await app.call(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks`,
        { title: 'From the wrong board' },
        otherKey,
      )
      expect(refused.status).toBe(409)
      expect(reasonOf(refused.body)).toBe('project_homed_elsewhere')
    })

    it('runs a research task and serves its findings, refusing it on the service task surface', async () => {
      const { app, wsId, write, decide } = await setup()
      const project = await createResearchProject(app, write)
      const task = await app.call<PublicProjectTask>(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks`,
        { title: 'Research the vendor' },
        write,
      )
      expect(task.status).toBe(201)
      expect(task.body).toMatchObject({ projectId: project.projectId, taskType: 'research' })
      const asServiceTask = await app.call(
        'GET',
        `/api/v1/tasks/${task.body.taskId}`,
        undefined,
        write,
      )
      expect(asServiceTask.status).toBe(422)
      expect(reasonOf(asServiceTask.body)).toBe('task_owned_by_project')

      const started = await app.call<PublicProjectTask>(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks/${task.body.taskId}/start`,
        {},
        decide,
      )
      expect(started.status).toBe(202)
      await app.drive(wsId)
      const run = await app.call<{ status: string }>(
        'GET',
        `/api/v1/tasks/${task.body.taskId}/run`,
        undefined,
        write,
      )
      expect(run.status).toBe(200)

      const findings = await app.call<PublicProjectFindings>(
        'GET',
        `/api/v1/projects/${project.projectId}/findings`,
        undefined,
        write,
      )
      expect(findings.status).toBe(200)
      expect(findings.body.revisions).toHaveLength(1)
      expect(findings.body.coverage.total.answered).toBe(2)
      const revisionId = findings.body.revisions[0]!.id
      const revision = await app.call<{ findings: unknown[] }>(
        'GET',
        `/api/v1/projects/${project.projectId}/findings/revisions/${revisionId}`,
        undefined,
        write,
      )
      expect(revision.status).toBe(200)
      expect(revision.body.findings).toHaveLength(2)
    })

    it('links a researched project to a service task, created with it or after', async () => {
      const { app, wsId, write, decide } = await setup()
      const project = await createResearchProject(app, write)
      const services = await app.call<{ services: Array<{ serviceId: string }> }>(
        'GET',
        '/api/v1/services',
        undefined,
        write,
      )
      const serviceId = services.body.services[0]!.serviceId
      const tooEarly = await app.call(
        'POST',
        `/api/v1/services/${serviceId}/tasks`,
        { title: 'Integrate', projects: [project.projectId] },
        write,
      )
      expect(tooEarly.status).toBe(422)
      expect(reasonOf(tooEarly.body)).toBe('project_has_no_result')

      const research = await app.call<PublicProjectTask>(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks`,
        { title: 'Research the vendor' },
        write,
      )
      await app.call(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks/${research.body.taskId}/start`,
        {},
        decide,
      )
      await app.drive(wsId)

      const created = await app.call<{ taskId: string }>(
        'POST',
        `/api/v1/services/${serviceId}/tasks`,
        { title: 'Integrate', projects: [project.projectId] },
        write,
      )
      expect(created.status).toBe(201)
      const path = `/api/v1/tasks/${created.body.taskId}/projects`
      const listed = await app.call<{ projects: Array<{ projectId: string }> }>(
        'GET',
        path,
        undefined,
        write,
      )
      expect(listed.body.projects.map((p) => p.projectId)).toEqual([project.projectId])

      const detached = await app.call(
        'POST',
        `${path}/detach`,
        { projectId: project.projectId },
        write,
      )
      expect(detached.status).toBe(204)
      const relinked = await app.call<{ projectId: string }>(
        'POST',
        path,
        { projectId: project.projectId },
        write,
      )
      expect(relinked.status).toBe(201)
      expect(relinked.body.projectId).toBe(project.projectId)
      const foreign = await app.call('POST', path, { projectId: 'prj_missing' }, write)
      expect(foreign.status).toBe(422)
      expect(reasonOf(foreign.body)).toBe('project_link_invalid')
    })

    it('resumes a run parked on a missing credential once it is stored', async () => {
      const { app, wsId, write, decide } = await setup({
        researchCredentialRequest: {
          key: 'VENDOR_LOGIN',
          reason: 'The admin pages need a login',
          observed: 'Redirected to the sign-in page',
        },
      })
      const project = await createResearchProject(app, write)
      const task = await app.call<PublicProjectTask>(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks`,
        { title: 'Research the vendor' },
        write,
      )
      await app.call(
        'POST',
        `/api/v1/projects/${project.projectId}/tasks/${task.body.taskId}/start`,
        {},
        decide,
      )
      const parked = (await app.drive(wsId)).find((e) => e.blockId === task.body.taskId)!
      expect(parked.status).toBe('blocked')
      const resume = `/api/v1/runs/${parked.id}/credential/resume`
      const early = await app.call('POST', resume, undefined, decide)
      expect(early.status).toBe(409)
      expect(reasonOf(early.body)).toBe('capability_credential_still_missing')
      const stored = await app.call(
        'PUT',
        `/workspaces/${wsId}/capability-credentials/VENDOR_LOGIN`,
        { value: 'vendor-login-secret' },
      )
      expect(stored.status).toBe(200)
      const resumed = await app.call<{ runId: string }>('POST', resume, undefined, decide)
      expect(resumed.status).toBe(200)
      const done = (await app.drive(wsId)).find((e) => e.blockId === task.body.taskId)!
      expect(done.status).toBe('done')
    })
  })
}
