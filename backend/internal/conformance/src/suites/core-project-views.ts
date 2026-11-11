import type {
  OutcomeStoragePolicyView,
  Project,
  ProjectBoardView,
  ProjectOutcomeDetail,
  ResearchProjectView,
} from '@cat-factory/contracts'
import type { Block } from '@cat-factory/kernel'
import { RESEARCH_PIPELINE_ID, defaultProjectDefinitionRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceAppOptions, ConformanceHarness } from '../harness.js'
import { memoryBinaryArtifactStore } from './shared.js'

// The app's read of a project on a board, whatever its kind: the pin and its definition, every
// outcome with where its body lives (an unreadable offloaded body is stated, never folded as if
// absent), whether each declared credential resolves for the board, the view its kind computes,
// and the outcome-storage policy tiers a board reads and sets. The research kind drives it; the
// routes never name it.

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

export function defineCoreProjectViewsConformance(harness: ConformanceHarness): void {
  describe('project board views', () => {
    async function setup(appOptions: ConformanceAppOptions = {}) {
      const app = harness.makeApp(
        { asyncKinds: ['project-researcher'] },
        { projectDefinitionRegistry: definitions(), ...appOptions },
      )
      const home = await app.createOrgWorkspace({ seed: true })
      const wsId = home.workspace.id
      const created = await app.call<{ project: Project }>('POST', `/workspaces/${wsId}/projects`, {
        kind: 'research',
        title: 'Vendor research',
        definition: { key: 'acme:vendor' },
      })
      expect(created.status).toBe(201)
      const project = created.body.project
      const view = () =>
        app.call<ProjectBoardView>('GET', `/workspaces/${wsId}/projects/${project.id}/view`)
      const accountId = (await app.workspaceRepository().accountOf(wsId))!
      return { app, wsId, project, view, accountId }
    }

    async function runTask(
      app: Awaited<ReturnType<typeof setup>>['app'],
      wsId: string,
      project: Project,
    ) {
      const task = await app.call<Block>(
        'POST',
        `/workspaces/${wsId}/blocks/${project.rootBlockId}/tasks`,
        { title: 'Research the vendor', taskType: 'research' },
      )
      expect(task.status).toBe(201)
      const started = await app.call(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.id}/executions`,
        {
          pipelineId: RESEARCH_PIPELINE_ID,
        },
      )
      expect(started.status).toBe(201)
      const exec = (await app.drive(wsId)).find((e) => e.blockId === task.body.id)!
      expect(exec.status).toBe('done')
      return task.body
    }

    it("reads the pin, each outcome, whether each credential resolves and the kind's view", async () => {
      const { app, wsId, project, view } = await setup()
      const before = await view()
      expect(before.status).toBe(200)
      expect(before.body).toMatchObject({
        kind: 'research',
        pin: { definitionKey: 'acme:vendor', definitionVersion: 1 },
        definition: { key: 'acme:vendor', version: 1 },
        definitionChanged: false,
        outcomes: [],
        credentials: [{ key: 'VENDOR_LOGIN', label: 'Vendor login', status: 'missing' }],
      })
      const empty = before.body.view as ResearchProjectView
      expect(empty.latestRevisionId).toBeNull()
      expect(empty.coverage.total.unanswered).toBe(2)

      const task = await runTask(app, wsId, project)
      const after = (await view()).body
      const research = after.view as ResearchProjectView
      expect(research.coverage.total.answered).toBe(2)
      expect(research.latestRevisionId).toBe(`pout_${task.id}`)
      expect(after.outcomes).toHaveLength(1)
      expect(after.outcomes[0]).toMatchObject({
        seq: 1,
        stream: 'main',
        taskId: task.id,
        storage: { placement: 'inline', readable: true },
      })
      expect(after.outcomes[0]!.storage.bytes).toBeGreaterThan(0)

      const detail = await app.call<ProjectOutcomeDetail>(
        'GET',
        `/workspaces/${wsId}/projects/${project.id}/outcomes/pout_${task.id}`,
      )
      expect(detail.status).toBe(200)
      const body = detail.body.body as { findings: Array<{ questionId: string }> }
      expect(body.findings.map((f) => f.questionId).sort()).toEqual(['scheme', 'scopes'])

      const stored = await app.call(
        'PUT',
        `/workspaces/${wsId}/capability-credentials/VENDOR_LOGIN`,
        {
          value: 'vendor-login-secret',
        },
      )
      expect(stored.status).toBe(200)
      expect((await view()).body.credentials[0]?.status).toBe('stored')
    })

    it('states an offloaded body it cannot read rather than folding without it', async () => {
      const store = memoryBinaryArtifactStore()
      const { app, wsId, project, view } = await setup({
        resolveBinaryArtifactStore: () => Promise.resolve(store),
      })
      await app
        .outcomeStoragePolicyRepository()
        .set('project', project.id, { inlineMaxBytes: 16, offload: 'enabled' })
      const task = await runTask(app, wsId, project)
      const [artifact] = await store.listByBlock(wsId, project.rootBlockId)
      expect((await view()).body.outcomes[0]?.storage).toMatchObject({
        placement: 'offloaded',
        readable: true,
      })

      await store.delete(wsId, artifact!.id)
      const after = (await view()).body
      expect(after.outcomes[0]?.storage).toMatchObject({ placement: 'offloaded', readable: false })
      expect((after.view as ResearchProjectView).findings).toEqual([])
      const detail = await app.call(
        'GET',
        `/workspaces/${wsId}/projects/${project.id}/outcomes/pout_${task.id}`,
      )
      expect(detail.status).toBe(503)
      expect(reasonOf(detail.body)).toBe('outcome_body_unavailable')
    })

    it('reads and sets the storage tiers a board owns, and refuses a project it does not mount', async () => {
      const { app, wsId, project, accountId } = await setup()
      const path = `/workspaces/${wsId}/outcome-storage-policy`
      const initial = await app.call<OutcomeStoragePolicyView>(
        'GET',
        `${path}?projectId=${project.id}`,
      )
      expect(initial.status).toBe(200)
      expect(initial.body).toMatchObject({ account: null, workspace: null, project: null })
      expect(initial.body.effective.offload).toBe('enabled')

      // The account tier is set under the account by one of its members.
      const { accountId: ownAccount, ownerUserId } = await app
        .onboarding()
        .makeOrgOwner(`outcomes-${project.id}`)
      const owner = { authorization: `Bearer ${await app.session({ id: ownerUserId })}` }
      const accountPath = `/accounts/${ownAccount}/outcome-storage-policy`
      const account = await app.call(
        'PUT',
        accountPath,
        { policy: { inlineMaxBytes: 4096 } },
        owner,
      )
      expect(account.status).toBe(200)
      expect((await app.call('GET', accountPath, undefined, owner)).body).toEqual({
        policy: { inlineMaxBytes: 4096 },
      })
      // The board's account reads the tier its own account set.
      await app.outcomeStoragePolicyRepository().set('account', accountId, { inlineMaxBytes: 4096 })
      expect(
        (await app.call('PUT', path, { tier: 'workspace', policy: { offload: 'disabled' } }))
          .status,
      ).toBe(200)
      const project1 = await app.call<OutcomeStoragePolicyView>('PUT', path, {
        tier: 'project',
        projectId: project.id,
        policy: { inlineMaxBytes: 1024 },
      })
      expect(project1.status).toBe(200)
      expect(project1.body).toMatchObject({
        account: { inlineMaxBytes: 4096 },
        workspace: { offload: 'disabled' },
        project: { inlineMaxBytes: 1024 },
        effective: { inlineMaxBytes: 1024, offload: 'disabled' },
      })

      const cleared = await app.call<OutcomeStoragePolicyView>('PUT', path, {
        tier: 'project',
        projectId: project.id,
        policy: {},
      })
      expect(cleared.body.project).toBeNull()
      expect(cleared.body.effective.inlineMaxBytes).toBe(4096)

      const missing = await app.call('PUT', path, {
        tier: 'project',
        projectId: 'prj_missing',
        policy: null,
      })
      expect(missing.status).toBe(404)
    })
  })
}
