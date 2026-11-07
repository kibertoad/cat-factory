import type { Project } from '@cat-factory/contracts'
import type { Block, ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { RESEARCH_PIPELINE_ID, ResearchDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { FakeAgentOptions } from '../FakeAgentExecutor.js'
import type { ConformanceHarness, ConformanceAppOptions } from '../harness.js'
import { memoryBinaryArtifactStore } from './shared.js'

// Research runs: a `research` task under a research project dispatches the `project-researcher`
// step with its brief, claims one findings sequence number per task, records one findings
// revision, and parks on a credential the agent asks for with its partial findings kept on the
// step. Pins the engine half and both stores' round-trip of the step's research state.

function definitions(): ResearchDefinitionRegistry {
  const registry = new ResearchDefinitionRegistry()
  registry.register({
    key: 'acme:vendor',
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
        onboarding: { instructions: 'Create a user under Admin, Users.' },
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

export function defineCoreResearchRunsConformance(harness: ConformanceHarness): void {
  describe('research runs', () => {
    async function setup(
      agentOptions: FakeAgentOptions = {},
      appOptions: ConformanceAppOptions = {},
    ) {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'], ...agentOptions },
        { researchDefinitionRegistry: definitions(), ...appOptions },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Vendor research',
        research: { definitionKey: 'acme:vendor' },
      })
      expect(created.status).toBe(201)
      return { app, wsId, project: created.body.project }
    }

    async function runTask(
      app: Awaited<ReturnType<typeof setup>>['app'],
      wsId: string,
      project: Project,
      fields: Record<string, unknown> = {},
    ): Promise<{ task: Block; exec: ExecutionInstance }> {
      const task = await app.call<Block>(
        'POST',
        `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`,
        { title: 'Research the vendor', taskType: 'research', taskTypeFields: fields },
      )
      expect(task.status).toBe(201)
      expect(task.body.pipelineId).toBe(RESEARCH_PIPELINE_ID)
      const started = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        {
          pipelineId: RESEARCH_PIPELINE_ID,
        },
      )
      expect(started.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      return { task: task.body, exec }
    }

    it('records one findings revision per task, in the order the tasks started', async () => {
      const { app, wsId, project } = await setup()
      const first = await runTask(app, wsId, project)
      expect(first.exec.status).toBe('done')
      const step = first.exec.steps.find((s) => s.agentKind === 'project-researcher')!
      expect(step.research).toMatchObject({
        projectId: project.id,
        seq: 1,
        mode: 'initial',
        definitionKey: 'acme:vendor',
        questionIds: ['scheme', 'scopes'],
        revisionId: `frv_${first.task.id}`,
      })
      expect(step.output).toContain('Recorded findings revision 1')
      expect(step.output).toContain('2 answered')
      const second = await runTask(app, wsId, project, { researchMode: 'refresh' })
      expect(second.exec.status).toBe('done')
      expect(
        second.exec.steps.find((s) => s.agentKind === 'project-researcher')?.research?.seq,
      ).toBe(2)
    })

    it('parks on a credential the agent asks for, keeping its partial findings on the step', async () => {
      const { app, wsId, project } = await setup({
        researchCredentialRequest: {
          key: 'VENDOR_LOGIN',
          reason: 'The admin pages need a login',
          observed: 'Redirected to the sign-in page',
        },
      })
      const { exec } = await runTask(app, wsId, project)
      expect(exec.status).toBe('blocked')
      const step = exec.steps[exec.currentStep]!
      expect(step.credentialWait).toMatchObject({
        subject: 'capability',
        key: 'VENDOR_LOGIN',
        declaredBy: { kind: 'research-definition', id: 'acme:vendor' },
        label: 'Vendor login',
        onboarding: { instructions: 'Create a user under Admin, Users.' },
        observed: 'Redirected to the sign-in page',
      })
      expect(step.research?.seq).toBe(1)
      const checkpoint = step.research?.checkpoint as { findings: { questionId: string }[] }
      expect(checkpoint.findings.map((f) => f.questionId)).toEqual(['scheme'])
      expect(step.research?.revisionId).toBeUndefined()
    })

    it('resumes a parked run once the credential is stored, keeping the checkpointed answers', async () => {
      const { app, wsId, project } = await setup({
        researchCredentialRequest: {
          key: 'VENDOR_LOGIN',
          reason: 'The admin pages need a login',
          observed: 'Redirected to the sign-in page',
        },
      })
      const { task, exec } = await runTask(app, wsId, project)
      expect(exec.status).toBe('blocked')
      const resume = `/workspaces/${wsId}/executions/${exec.id}/credential/resume`
      const early = await app.call('POST', resume)
      expect(early.status).toBe(409)
      expect(reasonOf(early.body)).toBe('capability_credential_still_missing')

      const stored = await app.call(
        'PUT',
        `/workspaces/${wsId}/capability-credentials/VENDOR_LOGIN`,
        { value: 'vendor-login-secret' },
      )
      expect(stored.status).toBe(200)
      expect((await app.call('POST', resume)).status).toBe(200)
      const done = (await app.drive(wsId)).find((e) => e.blockId === task.id)!
      expect(done.status).toBe('done')
      const step = done.steps.find((s) => s.agentKind === 'project-researcher')!
      // Still one revision for the task, under the sequence number its first dispatch claimed.
      expect(step.research).toMatchObject({ seq: 1, revisionId: `frv_${task.id}` })
      expect(step.output).toContain('2 answered')
    })

    it('offloads a body over the threshold and reads it back for the next task', async () => {
      const store = memoryBinaryArtifactStore()
      const { app, wsId, project } = await setup(
        {},
        { resolveBinaryArtifactStore: () => Promise.resolve(store) },
      )
      await app
        .findingsStoragePolicyRepository()
        .set('project', project.id, { inlineMaxBytes: 16, offload: 'enabled' })
      const first = await runTask(app, wsId, project)
      expect(first.exec.status).toBe('done')
      const offloaded = await store.listByBlock(wsId, project.rootBlockId)
      expect(offloaded.map((a) => a.kind)).toEqual(['findings'])
      // A refresh asks the questions the offloaded revision answered, so its body was read back.
      const second = await runTask(app, wsId, project, { researchMode: 'refresh' })
      expect(second.exec.status).toBe('done')
      expect(
        second.exec.steps.find((s) => s.agentKind === 'project-researcher')?.research?.questionIds,
      ).toEqual(['scheme', 'scopes'])
    })

    // Deleting a board is mothership-internal (a node never proxies `workspaceRepository.delete`),
    // so a mothership node cannot serve it; the mothership's own facade runs this test.
    it.skipIf(harness.name === 'mothership')(
      'carries an offloaded body to the board that inherits the project',
      async () => {
        const store = memoryBinaryArtifactStore()
        const { app, wsId, project } = await setup(
          {},
          { resolveBinaryArtifactStore: () => Promise.resolve(store) },
        )
        await app
          .findingsStoragePolicyRepository()
          .set('project', project.id, { inlineMaxBytes: 16, offload: 'enabled' })
        expect((await runTask(app, wsId, project)).exec.status).toBe('done')
        const accountId = (await app.workspaceRepository().accountOf(wsId))!
        const other = await app.createWorkspaceInAccount(accountId, null, { name: 'Other board' })
        const otherId = other.workspace.id
        await app.call('POST', `/workspaces/${otherId}/projects/${project.id}/mount`, {})
        expect((await app.call('DELETE', `/workspaces/${wsId}`)).status).toBe(204)
        expect((await store.listByBlock(otherId, project.rootBlockId)).map((a) => a.kind)).toEqual([
          'findings',
        ])
        const refresh = await runTask(app, otherId, project, { researchMode: 'refresh' })
        expect(refresh.exec.status).toBe('done')
      },
    )

    // A mothership node cannot resolve the account's content storage (the settings row carries
    // sealed storage credentials and stays mothership-internal), so it cannot tell "no storage"
    // from "storage it cannot reach". Media artifacts share the limitation on a node.
    it.skipIf(harness.name === 'mothership')(
      'keeps a small body inline when no content storage is configured',
      async () => {
        const { app, wsId, project } = await setup()
        await app
          .findingsStoragePolicyRepository()
          .set('project', project.id, { inlineMaxBytes: 16, offload: 'enabled' })
        const { exec } = await runTask(app, wsId, project)
        expect(exec.status).toBe('done')
      },
    )

    it('refuses a research task under a service', async () => {
      const { app, wsId } = await setup()
      const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
      const frameId = snap.serviceCatalog?.[0]?.frameBlockId
      expect(frameId).toBeTruthy()
      const refused = await app.call('POST', `/workspaces/${wsId}/blocks/${frameId}/tasks`, {
        title: 'Research here',
        taskType: 'research',
      })
      expect(refused.status).toBe(422)
      expect(reasonOf(refused.body)).toBe('task_type_requires_project')
    })
  })
}
