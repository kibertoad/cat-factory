import type { AdvanceResult } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/infrastructure/container'
import { D1ExecutionRepository } from '../../src/infrastructure/repositories/D1ExecutionRepository'
import { sweepStuckRuns } from '../../src/infrastructure/workflows/sweeper'
import { makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeWorkRunner, ThrowingAgentExecutor } from '../fakes/FakeWorkRunner'

const clock = { now: () => Date.now() }

/** Seed a workspace (blocks + pipelines) via the real app, sharing env.DB. */
async function seedWorkspace() {
  const { workspace } = await makeApp().createWorkspace()
  return workspace.id
}

describe('durable execution: advanceInstance', () => {
  it('advances a task run one step at a time to done', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, { agentExecutor: new FakeAgentExecutor({ confidence: 1 }) })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    let result: AdvanceResult = { kind: 'continue' }
    let steps = 0
    while (result.kind === 'continue' && steps++ < 20) {
      result = await c.executionService.advanceInstance(wsId, instance.id)
    }
    expect(result.kind).toBe('done')

    // A further advance is a safe no-op (the run is no longer running).
    expect((await c.executionService.advanceInstance(wsId, instance.id)).kind).toBe('noop')

    const snap = await makeApp().call<{ blocks: { id: string; status: string }[] }>(
      'GET',
      `/workspaces/${wsId}`,
    )
    expect(snap.body.blocks.find((b) => b.id === 'task_login')!.status).toBe('done')
  })

  it('reports awaiting_decision with the decision id when an agent pauses', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor({ decisionOnSteps: [0], confidence: 1 }),
    })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    const result = await c.executionService.advanceInstance(wsId, instance.id)
    expect(result.kind).toBe('awaiting_decision')
    if (result.kind === 'awaiting_decision') expect(result.decisionId).toMatch(/^dec/)
  })

  it('returns noop for a missing or finished run', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env)
    expect((await c.executionService.advanceInstance(wsId, 'exec_nope')).kind).toBe('noop')
  })

  it('advertises the execution mode on the snapshot', async () => {
    const app = makeApp()
    const created = await app.call<{ executionMode?: string }>('POST', '/workspaces', {})
    expect(created.body.executionMode).toBe('tick')
    const wsId = (created.body as { workspace: { id: string } }).workspace.id
    const snap = await app.call<{ executionMode?: string }>('GET', `/workspaces/${wsId}`)
    expect(snap.body.executionMode).toBe('tick')
  })
})

describe('durable execution: agent failure handling', () => {
  it('rethrows when rethrowAgentErrors is set (so a step can retry)', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, { agentExecutor: new ThrowingAgentExecutor() })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    await expect(
      c.executionService.advanceInstance(wsId, instance.id, { rethrowAgentErrors: true }),
    ).rejects.toThrow('boom')
  })

  it('swallows the error into step output by default (tick behaviour)', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, { agentExecutor: new ThrowingAgentExecutor() })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    const result = await c.executionService.advanceInstance(wsId, instance.id)
    expect(result.kind === 'continue' || result.kind === 'done').toBe(true)

    const repo = new D1ExecutionRepository({ db: env.DB, clock })
    const reloaded = await repo.get(wsId, instance.id)
    expect(reloaded!.steps[0]!.output).toContain('Agent error: boom')
  })
})

describe('durable execution: WorkRunner signalling', () => {
  it('signals start, decision resolution and cancel', async () => {
    const wsId = await seedWorkspace()
    const workRunner = new FakeWorkRunner()
    const c = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor({ decisionOnSteps: [0], confidence: 1 }),
      workRunner,
    })

    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')
    expect(workRunner.started).toContainEqual({ workspaceId: wsId, executionId: instance.id })

    const advanced = await c.executionService.advanceInstance(wsId, instance.id)
    expect(advanced.kind).toBe('awaiting_decision')
    const decisionId = advanced.kind === 'awaiting_decision' ? advanced.decisionId : ''
    await c.executionService.resolveDecision(wsId, instance.id, decisionId, 'Option A')
    expect(workRunner.signalled).toContainEqual({
      workspaceId: wsId,
      executionId: instance.id,
      decisionId,
      choice: 'Option A',
    })

    await c.executionService.cancel(wsId, 'task_login')
    expect(workRunner.cancelled).toContainEqual({ workspaceId: wsId, executionId: instance.id })
  })
})

describe('durable execution: sweeper', () => {
  it('re-drives a stale run whose workflow is not alive', async () => {
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
    const instance = await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const repo = new D1ExecutionRepository({ db: env.DB, clock })
    const workRunner = new FakeWorkRunner()
    // Negative lease => every running row counts as stale (now - (-x) > updated_at).
    const redriven = await sweepStuckRuns({
      executionRepository: repo,
      workflowLookup: { isAlive: async () => false },
      workRunner,
      clock,
      leaseMs: -60_000,
    })

    expect(redriven).toBeGreaterThanOrEqual(1)
    expect(workRunner.started.some((s) => s.executionId === instance.id)).toBe(true)
  })

  it('leaves runs alone while their workflow is alive', async () => {
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
    await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const repo = new D1ExecutionRepository({ db: env.DB, clock })
    const workRunner = new FakeWorkRunner()
    const redriven = await sweepStuckRuns({
      executionRepository: repo,
      workflowLookup: { isAlive: async () => true },
      workRunner,
      clock,
      leaseMs: -60_000,
    })

    expect(redriven).toBe(0)
    expect(workRunner.started.length).toBe(0)
  })
})
