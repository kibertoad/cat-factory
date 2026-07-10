import type { AgentRunRef } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from '@cat-factory/orchestration'
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/infrastructure/container'
import { D1AgentRunRepository } from '../../src/infrastructure/repositories/D1AgentRunRepository'
import { D1ExecutionRepository } from '../../src/infrastructure/repositories/D1ExecutionRepository'
import { sweepStuckRuns } from '../../src/infrastructure/workflows/sweeper'
import { buildWorkflowRuntime } from '../../src/infrastructure/workflows/runtime'
import { makeApp } from '../helpers'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'
import { FakeWorkRunner, ThrowingAgentExecutor } from '../fakes/FakeWorkRunner'

const clock = { now: () => Date.now() }

/** Seed a workspace (blocks + pipelines) via the real app, sharing env.DB. */
async function seedWorkspace() {
  const { workspace } = await makeApp().createWorkspace()
  return workspace.id
}

/**
 * Drive a run until a step actually halts (a result other than `continue`), mirroring the
 * durable driver's re-entry loop. A `coder` step spends its FIRST advance resolving the
 * (default-off) implementation-fork decision phase — recording `skipped` and returning
 * `continue` — so the Coder agent's own work (its decision pause / throw / error-swallow)
 * lands on the NEXT advance. Looping here keeps these single-step assertions robust to that
 * extra mechanical cycle, exactly as the "one step at a time to done" test already does.
 */
async function advanceUntilHalt(
  c: ReturnType<typeof buildContainer>,
  wsId: string,
  executionId: string,
  options?: AdvanceOptions,
): Promise<AdvanceResult> {
  let result: AdvanceResult = { kind: 'continue' }
  let steps = 0
  while (result.kind === 'continue' && steps++ < 20) {
    result = await c.executionService.advanceInstance(wsId, executionId, options)
  }
  return result
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

    const result = await advanceUntilHalt(c, wsId, instance.id)
    expect(result.kind).toBe('awaiting_decision')
    if (result.kind === 'awaiting_decision') expect(result.decisionId).toMatch(/^dec/)
  })

  it('returns noop for a missing or finished run', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, { agentExecutor: new FakeAgentExecutor() })
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
      advanceUntilHalt(c, wsId, instance.id, { rethrowAgentErrors: true }),
    ).rejects.toThrow('boom')
  })

  it('swallows the error into step output by default', async () => {
    const wsId = await seedWorkspace()
    const c = buildContainer(env, {
      agentExecutor: new ThrowingAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await c.executionService.start(wsId, 'task_login', 'pl_quick')

    const result = await advanceUntilHalt(c, wsId, instance.id)
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

    const advanced = await advanceUntilHalt(c, wsId, instance.id)
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
      failStalled: async () => {},
      clock,
      leaseMs: -60_000,
      // Large deadline: these cases exercise redrive/finalize, not the hard-stall path.
      hardStallMs: 60 * 60 * 1000,
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
      failStalled: async () => {},
      clock,
      leaseMs: -60_000,
      // Large deadline: these cases exercise redrive/finalize, not the hard-stall path.
      hardStallMs: 60 * 60 * 1000,
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
      failStalled: async () => {},
      clock,
      leaseMs: -60_000,
      // Large deadline: these cases exercise redrive/finalize, not the hard-stall path.
      hardStallMs: 60 * 60 * 1000,
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
      failStalled: async () => {},
      clock,
      leaseMs: -60_000,
      // Large deadline: these cases exercise redrive/finalize, not the hard-stall path.
      hardStallMs: 60 * 60 * 1000,
    })

    expect(result.redriven).toBeGreaterThanOrEqual(1)
    expect(redrove.some((r) => r.id === 'boot_stale' && r.kind === 'bootstrap')).toBe(true)
  })

  it('fails a still-missing execution as stalled once past the hard-stall deadline', async () => {
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const redrove: AgentRunRef[] = []
    const stalledRuns: AgentRunRef[] = []
    const result = await sweepStuckRuns({
      agentRunRepository,
      // Instance never came back; recovery would just re-create-and-lose it forever.
      instanceState: async () => 'missing',
      redrive: async (ref) => {
        redrove.push(ref)
      },
      finalizeOrphan: async () => {},
      // Mirror the production `failStalled` (index.ts): actually fail the run so the DB
      // assertions below exercise the real terminal transition, not just the callback.
      failStalled: async (ref) => {
        stalledRuns.push(ref)
        await starter.executionService.failRun(
          ref.workspaceId,
          ref.id,
          'Run stalled: its durable driver was lost and automatic recovery could not resume it.',
          'stalled',
          null,
        )
      },
      clock,
      leaseMs: -60_000,
      // Negative deadline => the just-created run counts as past the hard-stall window.
      hardStallMs: -60_000,
    })

    expect(result.stalled).toBeGreaterThanOrEqual(1)
    expect(stalledRuns.some((r) => r.id === instance.id && r.kind === 'execution')).toBe(true)
    // Hard-stalled runs are failed, not re-driven.
    expect(redrove.some((r) => r.id === instance.id)).toBe(false)

    const failed = await starter.executionRepository.get(wsId, instance.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.failure?.kind).toBe('stalled')
  })

  it('re-drives (not stalls) a missing run on first observation even with a huge lease age', async () => {
    // F1: the hard-stall deadline must key off time-OBSERVED-orphaned, not raw lease age.
    // A run whose `updated_at` is hours old (e.g. after a cron outage) must still get at
    // least one re-drive before it can ever be failed `stalled`.
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    // Backdate the lease far past the (realistic, positive) hard-stall deadline.
    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const longAgo = Date.now() - 6 * 60 * 60 * 1000
    await env.DB.prepare(`UPDATE agent_runs SET updated_at = ? WHERE workspace_id = ? AND id = ?`)
      .bind(longAgo, wsId, instance.id)
      .run()

    const orphanedSince = new Map<string, number>()
    const redrove: AgentRunRef[] = []
    const stalledRuns: AgentRunRef[] = []
    const sweep = () =>
      sweepStuckRuns({
        agentRunRepository,
        instanceState: async () => 'missing',
        redrive: async (ref) => {
          redrove.push(ref)
        },
        finalizeOrphan: async () => {},
        failStalled: async (ref) => {
          stalledRuns.push(ref)
        },
        clock,
        leaseMs: -60_000,
        // Realistic positive deadline; only the per-process clock (not the 6h lease age)
        // should govern whether the run is stalled.
        hardStallMs: 60 * 60 * 1000,
        orphanedSince,
      })

    // First tick: despite the 6h lease age, the run is re-driven, not stalled.
    const first = await sweep()
    expect(first.redriven).toBeGreaterThanOrEqual(1)
    expect(first.stalled).toBe(0)
    expect(redrove.some((r) => r.id === instance.id)).toBe(true)
    expect(stalledRuns.length).toBe(0)
    // The per-process clock now remembers when the run was first seen orphaned.
    expect(orphanedSince.has(instance.id)).toBe(true)

    // Rewind that clock past the deadline to simulate the run staying orphaned across ticks.
    orphanedSince.set(instance.id, Date.now() - 2 * 60 * 60 * 1000)
    const second = await sweep()
    expect(second.stalled).toBeGreaterThanOrEqual(1)
    expect(stalledRuns.some((r) => r.id === instance.id)).toBe(true)
    // Once failed, the run is dropped from the clock.
    expect(orphanedSince.has(instance.id)).toBe(false)
  })

  it('forgets a run that recovered so its hard-stall clock restarts', async () => {
    const wsId = await seedWorkspace()
    const starter = buildContainer(env, {
      agentExecutor: new FakeAgentExecutor(),
      workRunner: new FakeWorkRunner(),
    })
    const instance = await starter.executionService.start(wsId, 'task_login', 'pl_quick')

    const agentRunRepository = new D1AgentRunRepository({ db: env.DB })
    const orphanedSince = new Map<string, number>()
    const base = {
      agentRunRepository,
      redrive: async () => {},
      finalizeOrphan: async () => {},
      failStalled: async () => {},
      clock,
      leaseMs: -60_000,
      hardStallMs: 60 * 60 * 1000,
      orphanedSince,
    }

    // Tick 1: missing → clock started.
    await sweepStuckRuns({ ...base, instanceState: async () => 'missing' })
    expect(orphanedSince.has(instance.id)).toBe(true)

    // Tick 2: instance came back alive → clock forgotten.
    await sweepStuckRuns({ ...base, instanceState: async () => 'alive' })
    expect(orphanedSince.has(instance.id)).toBe(false)
  })
})

describe('workflow runtime construction (F5: survive a transient wake blip)', () => {
  // A fake durable sleeper that records each sleep instead of parking.
  const fakeStep = () => {
    const sleeps: string[] = []
    return { sleeps, sleep: async (name: string) => void sleeps.push(name) }
  }

  it('returns the build result on the first successful attempt (no sleeps)', async () => {
    const step = fakeStep()
    const out = await buildWorkflowRuntime(() => ({ ok: true }), step, 'exec')
    expect(out).toEqual({ ok: true })
    expect(step.sleeps).toEqual([])
  })

  it('retries a transient throw with a durable sleep, then succeeds', async () => {
    const step = fakeStep()
    let calls = 0
    const out = await buildWorkflowRuntime(
      () => {
        calls += 1
        if (calls < 2) throw new Error('transient wake blip')
        return { ok: true }
      },
      step,
      'exec',
    )
    expect(out).toEqual({ ok: true })
    expect(calls).toBe(2)
    // Exactly one durable sleep between the failed and the successful attempt.
    expect(step.sleeps).toEqual(['exec-build-retry-0'])
  })

  it('rethrows a persistent (deterministic) build failure after exhausting attempts', async () => {
    const step = fakeStep()
    let calls = 0
    await expect(
      buildWorkflowRuntime(
        () => {
          calls += 1
          throw new Error('missing required binding')
        },
        step,
        'exec',
        3,
      ),
    ).rejects.toThrow('missing required binding')
    // All attempts tried; a sleep between each but NOT after the last.
    expect(calls).toBe(3)
    expect(step.sleeps).toEqual(['exec-build-retry-0', 'exec-build-retry-1'])
  })
})
