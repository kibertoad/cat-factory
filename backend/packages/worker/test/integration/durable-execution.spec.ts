import type { AdvanceResult, AgentRunRef } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/infrastructure/container'
import { D1AgentRunRepository } from '../../src/infrastructure/repositories/D1AgentRunRepository'
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
    const c = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor({ confidence: 1 }),
      workRunner: new FakeWorkRunner(),
    })
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
      workRunner: new FakeWorkRunner(),
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
})

describe('durable execution: agent failure handling', () => {
  it('rethrows when rethrowAgentErrors is set (so a step can retry)', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, {
      agentExecutor: new ThrowingAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    await expect(
      c.executionService.advanceInstance(wsId, instance.id, { rethrowAgentErrors: true }),
    ).rejects.toThrow('boom')
  })

  it('swallows the error into step output by default', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, {
      agentExecutor: new ThrowingAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    const result = await c.executionService.advanceInstance(wsId, instance.id)
    expect(result.kind === 'continue' || result.kind === 'done').toBe(true)

    const repo = new D1ExecutionRepository({ db: env.DB, clock })
    const reloaded = await repo.get(wsId, instance.id)
    expect(reloaded!.steps[0]!.output).toContain('Agent error: boom')
  })
})

describe('durable execution: failRun + retry', () => {
  it('records a structured failure, blocks the block (not pr_ready), and retries', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor({ confidence: 1 }),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    await c.executionService.failRun(wsId, instance.id, 'kaboom', 'job_failed')

    const repo = new D1ExecutionRepository({ db: env.DB, clock })
    const failed = await repo.get(wsId, instance.id)
    expect(failed!.status).toBe('failed')
    expect(failed!.failure?.kind).toBe('job_failed')
    expect(failed!.failure?.message).toBe('kaboom')
    expect(failed!.failure?.hint).toBeTruthy()

    // The block surfaces the failure as "needs attention" — NOT the old pr_ready
    // (which looked like success and hid the failure).
    const snap = await makeApp().call<{ blocks: { id: string; status: string }[] }>(
      'GET',
      `/workspaces/${wsId}`,
    )
    expect(snap.body.blocks.find((b) => b.id === 'task_login')!.status).toBe('blocked')

    // Retry re-runs the same pipeline on the block as a fresh run.
    const retried = await c.executionService.retry(wsId, instance.id)
    expect(retried.status).toBe('running')
    expect(retried.blockId).toBe('task_login')
    expect(retried.id).not.toBe(instance.id)

    // Retrying a non-failed run is rejected.
    await expect(c.executionService.retry(wsId, retried.id)).rejects.toThrow(/failed/)
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
    const starter = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const redrove: AgentRunRef[] = []
    // Negative lease => every running row counts as stale (now - (-x) > updated_at).
    const result = await sweepStuckRuns({
      agentRunRepository,
      // `missing` => the instance was lost, so it is safe to (re-)create.
      instanceState: async () => 'missing',
      redrive: async (ref) => {
        redrove.push(ref)
      },
      finalizeOrphan: async () => {},
      clock,
      leaseMs: -60_000,
    })

    expect(result.redriven).toBeGreaterThanOrEqual(1)
    expect(redrove.some((r) => r.id === instance.id && r.kind === 'execution')).toBe(true)
  })

  it('leaves runs alone while their workflow is alive', async () => {
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const redrove: AgentRunRef[] = []
    const finalized: AgentRunRef[] = []
    const result = await sweepStuckRuns({
      agentRunRepository,
      instanceState: async () => 'alive',
      redrive: async (ref) => {
        redrove.push(ref)
      },
      finalizeOrphan: async (ref) => {
        finalized.push(ref)
      },
      clock,
      leaseMs: -60_000,
    })

    expect(result.redriven).toBe(0)
    expect(result.finalized).toBe(0)
    expect(redrove.length).toBe(0)
    expect(finalized.length).toBe(0)
  })

  it('finalizes a stale run whose workflow is terminal (cannot be re-driven)', async () => {
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const redrove: AgentRunRef[] = []
    const finalized: AgentRunRef[] = []
    const result = await sweepStuckRuns({
      agentRunRepository,
      // `terminal` => the instance ran and ended; it can't be recreated under the
      // same id, so the sweeper must finalize (not re-drive) the orphaned run.
      instanceState: async () => 'terminal',
      redrive: async (ref) => {
        redrove.push(ref)
      },
      finalizeOrphan: async (ref) => {
        finalized.push(ref)
      },
      clock,
      leaseMs: -60_000,
    })

    expect(result.finalized).toBeGreaterThanOrEqual(1)
    expect(redrove.length).toBe(0)
    expect(finalized.some((r) => r.id === instance.id && r.kind === 'execution')).toBe(true)
  })

  it('spans both kinds: re-drives a stale bootstrap run too', async () => {
    const wsId = await seedWorkspace()
    // Insert a stale, still-running bootstrap row directly (no container needed).
    const now = Date.now()
    await env.DB.prepare(
      `INSERT INTO agent_runs (workspace_id, id, kind, block_id, status, detail, created_at, updated_at)
       VALUES (?, 'boot_stale', 'bootstrap', 'blk_x', 'running', '{"repoName":"svc"}', ?, ?)`,
    )
      .bind(wsId, now, now)
      .run()

    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const redrove: AgentRunRef[] = []
    const result = await sweepStuckRuns({
      agentRunRepository,
      instanceState: async () => 'missing',
      redrive: async (ref) => {
        redrove.push(ref)
      },
      finalizeOrphan: async () => {},
      clock,
      leaseMs: -60_000,
    })

    expect(result.redriven).toBeGreaterThanOrEqual(1)
    expect(redrove.some((r) => r.id === 'boot_stale' && r.kind === 'bootstrap')).toBe(true)
  })
})
