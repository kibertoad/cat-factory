import type { Project } from '@cat-factory/contracts'
import type { Block, ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/kernel'
import { RESEARCH_PIPELINE_ID, defaultProjectDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { FakeAgentOptions } from '../FakeAgentExecutor.js'
import type { ConformanceHarness } from '../harness.js'

// Research runs, the built-in project kind driven through the generic project step: a `research`
// task under a research project dispatches the `project-researcher` step with its kind's brief,
// claims one outcome sequence number per task, records one outcome, and parks on a credential the
// agent asks for with its partial findings kept on the step. Pins the engine half and both
// stores' round-trip of the step's project state.

function definitions() {
  const registry = defaultProjectDefinitionRegistry()
  registry.register({
    kind: 'research',
    key: 'acme:vendor',
    version: 1,
    title: 'Vendor',
    spec: {
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
    },
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
    async function setup(agentOptions: FakeAgentOptions = {}) {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'], ...agentOptions },
        { projectDefinitionRegistry: definitions() },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Vendor research',
        definition: { key: 'acme:vendor' },
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

    it('records one outcome per task, in the order the tasks started', async () => {
      const { app, wsId, project } = await setup()
      const first = await runTask(app, wsId, project)
      expect(first.exec.status).toBe('done')
      const step = first.exec.steps.find((s) => s.agentKind === 'project-researcher')!
      expect(step.project).toMatchObject({
        projectId: project.id,
        kind: 'research',
        seq: 1,
        intent: 'initial',
        stream: 'main',
        definitionKey: 'acme:vendor',
        plan: { questionIds: ['scheme', 'scopes'] },
        outcomeId: `pout_${first.task.id}`,
      })
      expect(step.output).toContain('Recorded findings revision 1')
      expect(step.output).toContain('2 answered')
      const second = await runTask(app, wsId, project, { researchMode: 'refresh' })
      expect(second.exec.status).toBe('done')
      expect(
        second.exec.steps.find((s) => s.agentKind === 'project-researcher')?.project?.seq,
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
        declaredBy: { kind: 'project-definition', id: 'research/acme:vendor' },
        label: 'Vendor login',
        onboarding: { instructions: 'Create a user under Admin, Users.' },
        observed: 'Redirected to the sign-in page',
      })
      expect(step.project?.seq).toBe(1)
      const checkpoint = step.project?.checkpoint as { findings: { questionId: string }[] }
      expect(checkpoint.findings.map((f) => f.questionId)).toEqual(['scheme'])
      expect(step.project?.outcomeId).toBeUndefined()

      // Once the credential is stored the run resumes from its checkpoint: the resumed dispatch
      // answers only what the checkpoint left open, and the one outcome it records is the merge.
      const stored = await app.call(
        'PUT',
        `/workspaces/${wsId}/capability-credentials/VENDOR_LOGIN`,
        { value: 'vendor-login' },
      )
      expect(stored.status).toBe(200)
      const resumed = await app.call(
        'POST',
        `/workspaces/${wsId}/executions/${exec.id}/credential/resume`,
      )
      expect(resumed.status).toBe(200)
      const done = (await app.drive(wsId)).find((e) => e.id === exec.id)!
      expect(done.status).toBe('done')
      const finished = done.steps.find((s) => s.agentKind === 'project-researcher')!
      expect(finished.project).toMatchObject({ seq: 1, outcomeId: `pout_${exec.blockId}` })
      expect(finished.output).toContain('2 answered')
    })

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
