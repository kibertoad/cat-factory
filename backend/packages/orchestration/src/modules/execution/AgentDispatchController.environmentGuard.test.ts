import { describe, expect, it } from 'vitest'
import type { AgentRunContext, Block, PipelineStep } from '@cat-factory/kernel'
import { AgentDispatchController, type AgentDispatchDeps } from './AgentDispatchController.js'
import type { StepHandlerContext } from './step-handler-registry.js'

// WHERE the ephemeral-environment dispatch guard sits in `handleAgentStep`, which is a different
// question from what it decides (that is `environmentDispatch.logic.test.ts`).
//
// It belongs INSIDE the re-attach gate, beside the pre-ops, because it judges the environment as
// it stands NOW and a re-attach's environment has moved on since the job started. An ephemeral env
// carries a TTL and a tester routinely outlives it, so a guard sitting ahead of that gate fails a
// run whose container is alive, still working, and holding a runner that nothing would then
// reclaim — turning a guard against untested work into a way to throw good work away.

const BLOCK = { id: 'block-1', level: 'task', title: 'Add pagination' } as unknown as Block

/** A tester on a service that DECLARES provisioning: always in ephemeral-environment mode. */
function context(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'tester-api',
    service: { type: 'service', provisioning: { type: 'custom' } },
    // Expired mid-run: the environment exists, its TTL elapsed, and it publishes no address.
    environment: { status: 'expired', url: null },
    ...over,
  } as unknown as AgentRunContext
}

function controller(ctx: AgentRunContext) {
  const calls = { preOps: 0, dispatched: 0 }
  const deps = {
    contextBuilder: { buildContext: async () => ctx },
    repoOps: {
      runRegisteredPreOps: async () => {
        calls.preOps += 1
      },
    },
    deployer: { attachEnvironmentProjection: async () => false },
    runStateMachine: { persistAndEmit: async () => undefined },
    clock: { now: () => 1_700_000_000_000 },
    agentExecutor: {
      runsAsync: () => true,
      pollJob: async () => ({ state: 'running' }),
      startJob: async () => {
        calls.dispatched += 1
        return { jobId: 'job-2' }
      },
    },
  } as unknown as AgentDispatchDeps
  return { controller: new AgentDispatchController(deps), calls }
}

function handlerContext(step: PipelineStep): StepHandlerContext {
  return {
    workspaceId: 'ws-1',
    instance: { id: 'exec-1', blockId: BLOCK.id, currentStep: 1, steps: [{}, {}] },
    step,
    block: BLOCK,
    isFinalStep: false,
    options: {},
  } as unknown as StepHandlerContext
}

describe('AgentDispatchController: the ephemeral-environment guard', () => {
  it('refuses a FIRST dispatch with no reachable environment', async () => {
    const step = { agentKind: 'tester-api' } as unknown as PipelineStep
    const { controller: c, calls } = controller(context())

    const result = await c.handleAgentStep(handlerContext(step))

    expect(result).toMatchObject({
      kind: 'job_failed',
      failureKind: 'environment',
      reason: 'environment_not_ready',
    })
    // Refused BEFORE the kind's pre-ops commit anything to the repo, and before any container is
    // contacted: the run pays nothing for a dispatch that could only produce unverified work.
    expect(calls).toEqual({ preOps: 0, dispatched: 0 })
  })

  it('re-attaches to a live job whose environment has since expired, rather than failing it', async () => {
    // `jobId` set = the job already dispatched (a durable replay, a Node worker restart, a sweeper
    // re-drive). The environment was reachable when the tester started; it has since expired.
    const step = { agentKind: 'tester-api', jobId: 'job-1' } as unknown as PipelineStep
    const { controller: c, calls } = controller(context())

    const result = await c.handleAgentStep(handlerContext(step))

    expect(result).toEqual({ kind: 'awaiting_job', jobId: 'job-1', stepIndex: 1 })
    // No second dispatch, and the guard did not fire: the running container keeps its work.
    expect(calls).toEqual({ preOps: 0, dispatched: 0 })
  })

  it('dispatches a first-time step whose environment IS reachable', async () => {
    const step = { agentKind: 'tester-api' } as unknown as PipelineStep
    const { controller: c, calls } = controller(
      context({
        environment: { status: 'ready', url: 'https://pr-8.example.test' },
      } as Partial<AgentRunContext>),
    )

    const result = await c.handleAgentStep(handlerContext(step))

    expect(result).toMatchObject({ kind: 'awaiting_job', jobId: 'job-2' })
    expect(calls).toEqual({ preOps: 1, dispatched: 1 })
  })
})
