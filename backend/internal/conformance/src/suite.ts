import type {
  Block,
  ExecutionInstance,
  Pipeline,
  Workspace,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from './harness.js'

// The cross-runtime conformance suite: the KEY backend behaviour every deployment
// facade must implement identically. It is parameterised by a `ConformanceHarness`,
// so the exact same assertions run against the Cloudflare Worker (over D1, inside
// workerd) and the Node service (over real Postgres). Any behavioural drift between
// runtimes — a repository that maps a column differently, an engine path that only
// one facade wires — fails here instead of shipping silently.
//
// It deliberately covers the runtime-neutral core only (workspaces, board, the
// execution engine driven through the deterministic FakeAgentExecutor). Facade- or
// integration-specific behaviour (GitHub, documents, durable runners, real-time
// upgrade) stays in each runtime's own suite.

export function defineConformanceSuite(harness: ConformanceHarness): void {
  describe(`[${harness.name}] conformance`, () => {
    describe('workspaces', () => {
      it('creates a seeded board and returns a full snapshot', async () => {
        const { call } = harness.makeApp()
        const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { name: 'My board' })

        expect(res.status).toBe(201)
        expect(res.body.workspace.name).toBe('My board')
        expect(res.body.blocks.find((b) => b.id === 'blk_auth')).toBeTruthy()
        expect(res.body.pipelines).toHaveLength(4)
        expect(res.body.executions).toHaveLength(0)
      })

      it('creates an empty board when seed=false', async () => {
        const { call } = harness.makeApp()
        const res = await call<WorkspaceSnapshot>('POST', '/workspaces', { seed: false })

        expect(res.body.blocks).toHaveLength(0)
        expect(res.body.pipelines).toHaveLength(0)
      })

      it('lists and deletes boards', async () => {
        const { call, createWorkspace } = harness.makeApp()
        const { workspace } = await createWorkspace()

        const list = await call<Workspace[]>('GET', '/workspaces')
        expect(list.body.map((w) => w.id)).toContain(workspace.id)

        const del = await call('DELETE', `/workspaces/${workspace.id}`)
        expect(del.status).toBe(204)

        const after = await call('GET', `/workspaces/${workspace.id}`)
        expect(after.status).toBe(404)
      })

      it('returns 404 for an unknown board', async () => {
        const { call } = harness.makeApp()
        const res = await call<{ error: { code: string } }>('GET', '/workspaces/missing')

        expect(res.status).toBe(404)
        expect(res.body.error.code).toBe('not_found')
      })

      it('isolates blocks between boards', async () => {
        const { createWorkspace } = harness.makeApp()
        const a = await createWorkspace()
        const b = await createWorkspace()

        expect(a.workspace.id).not.toBe(b.workspace.id)
        expect(a.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
        expect(b.blocks.find((x) => x.id === 'blk_auth')).toBeTruthy()
      })
    })

    describe('board', () => {
      it('adds a top-level frame', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call<Block>('POST', `/workspaces/${workspace.id}/blocks`, {
          type: 'service',
          position: { x: 10, y: 20 },
        })
        expect(res.status).toBe(201)
        expect(res.body.level).toBe('frame')
      })

      it('adds a user-authored task pinning a pipeline', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call<Block>(
          'POST',
          `/workspaces/${workspace.id}/blocks/blk_auth/tasks`,
          { title: 'Add SSO login', description: 'Support SAML and OIDC.', pipelineId: 'pl_quick' },
        )
        expect(res.status).toBe(201)
        expect(res.body.level).toBe('task')
        expect(res.body.parentId).toBe('blk_auth')
        expect(res.body.title).toBe('Add SSO login')
        expect(res.body.pipelineId).toBe('pl_quick')
      })

      it('rejects a task without a title', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/blk_auth/tasks`, {})
        expect(res.status).toBe(400)
      })

      it('adds a module to a service but rejects one on a task', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const ok = await app.call<Block>(
          'POST',
          `/workspaces/${workspace.id}/blocks/blk_auth/modules`,
          { name: 'Tokens' },
        )
        expect(ok.status).toBe(201)
        expect(ok.body.level).toBe('module')

        const bad = await app.call(
          'POST',
          `/workspaces/${workspace.id}/blocks/task_login/modules`,
          {
            name: 'Nope',
          },
        )
        expect(bad.status).toBe(422)
      })

      it('updates a block', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const patched = await app.call<Block>(
          'PATCH',
          `/workspaces/${workspace.id}/blocks/blk_auth`,
          { description: 'Updated description' },
        )
        expect(patched.status).toBe(200)
        expect(patched.body.description).toBe('Updated description')
      })
    })

    describe('execution engine', () => {
      it('runs a task pipeline to auto-merge and materialises its module', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const start = await app.call<ExecutionInstance>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/executions`,
          { pipelineId: 'pl_quick' },
        )
        expect(start.status).toBe(201)
        expect(start.body.status).toBe('running')

        const ticked = await app.drive(wsId)
        const exec = ticked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('done')
        expect(exec.steps.every((s) => s.state === 'done')).toBe(true)
        expect(exec.steps[0]!.output).toContain('[coder]')
        expect(exec.steps[0]!.model).toBe('fake')
        for (const s of exec.steps) {
          expect(typeof s.startedAt).toBe('number')
          expect(typeof s.finishedAt).toBe('number')
          expect(s.finishedAt!).toBeGreaterThanOrEqual(s.startedAt!)
        }

        const snap = (await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)).body
        const task = snap.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('done')
        expect(task.confidence).toBe(1)
        // task_login is assigned to the existing "Sessions" module → moved inside it.
        expect(task.parentId).toBe('mod_sessions')
      })

      it('opens a PR when confidence is below threshold, then merges on demand', async () => {
        const app = harness.makeApp({ confidence: 0.5 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })
        await app.drive(wsId)

        const task = (
          await app.call<WorkspaceSnapshot>('GET', `/workspaces/${wsId}`)
        ).body.blocks.find((b) => b.id === 'task_login')!
        expect(task.status).toBe('pr_ready')
        expect(task.confidence).toBe(0.5)

        const merge = await app.call<{ status: string }>(
          'POST',
          `/workspaces/${wsId}/blocks/task_login/merge`,
        )
        expect(merge.status).toBe(200)
        expect(merge.body.status).toBe('done')
      })

      it('rejects merging a block with no open PR', async () => {
        const app = harness.makeApp()
        const { workspace } = await app.createWorkspace()
        const res = await app.call('POST', `/workspaces/${workspace.id}/blocks/task_login/merge`)
        expect(res.status).toBe(409)
      })

      it('pauses for a human decision and resumes after it is resolved', async () => {
        const app = harness.makeApp({ decisionOnSteps: [0], confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: 'pl_quick',
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        const step = exec.steps[0]!
        expect(step.state).toBe('waiting_decision')
        expect(step.decision).toBeTruthy()

        const choice = step.decision!.options[0]!
        const resolve = await app.call(
          'POST',
          `/workspaces/${wsId}/executions/${exec.id}/decisions/${step.decision!.id}`,
          { choice },
        )
        expect(resolve.status).toBe(200)

        const resumed = await app.drive(wsId)
        const finished = resumed.find((e) => e.blockId === 'task_login')!
        expect(finished.status).toBe('done')
        expect(finished.steps[0]!.decision!.chosen).toBe(choice)
      })

      it('pauses at an approval gate, then advances on approve', async () => {
        const app = harness.makeApp({ confidence: 1 })
        const { workspace } = await app.createWorkspace()
        const wsId = workspace.id

        const gated = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
          name: 'Gated',
          agentKinds: ['architect', 'coder'],
          gates: [true, false],
        })

        await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
          pipelineId: gated.body.id,
        })

        const blocked = await app.drive(wsId)
        const exec = blocked.find((e) => e.blockId === 'task_login')!
        expect(exec.status).toBe('blocked')
        const step = exec.steps[0]!
        expect(step.state).toBe('waiting_decision')
        expect(step.approval?.status).toBe('pending')
        expect(step.approval?.proposal).toBe(step.output)
        expect(exec.steps[1]!.state).toBe('pending')
      })
    })
  })
}
