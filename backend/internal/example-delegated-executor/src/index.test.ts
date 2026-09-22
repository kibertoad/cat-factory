import {
  defaultDelegatedExecutorRegistry,
  defaultPipelineRegistry,
  noopLogger,
  type DelegatedExecutorDeps,
} from '@cat-factory/kernel'
import { defaultAgentKindRegistry, delegatedExecutorFor, runsDelegated } from '@cat-factory/agents'
import { collectRegistrationProblems } from '@cat-factory/orchestration'
import { defaultGateRegistry } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  EXAMPLE_DELEGATED_KIND,
  EXAMPLE_EXECUTOR_ID,
  exampleDelegatedExecutor,
  registerExampleDelegation,
} from './index.js'

// The example is also the check that the PUBLIC seam is enough on its own: everything here is
// registered through the same app-owned registries a deployment injects, with no import from the
// engine's internals and no platform change to make it work.

function registries() {
  const agentKindRegistry = defaultAgentKindRegistry()
  const delegatedExecutorRegistry = defaultDelegatedExecutorRegistry()
  const pipelineRegistry = defaultPipelineRegistry()
  const system = registerExampleDelegation({
    agentKindRegistry,
    delegatedExecutorRegistry,
    pipelineRegistry,
  })
  return { agentKindRegistry, delegatedExecutorRegistry, pipelineRegistry, system }
}

const deps: DelegatedExecutorDeps = {
  logger: noopLogger,
  clock: { now: () => 0 },
  fetchImpl: async () => {
    throw new Error('the example executor makes no calls')
  },
}

describe('the example registration', () => {
  it('routes its kind to its executor through the public seam', () => {
    const { agentKindRegistry } = registries()
    expect(runsDelegated(EXAMPLE_DELEGATED_KIND, agentKindRegistry)).toBe(true)
    expect(delegatedExecutorFor(EXAMPLE_DELEGATED_KIND, agentKindRegistry)).toBe(
      EXAMPLE_EXECUTOR_ID,
    )
  })

  it('passes boot validation, which is what makes it a usable example', () => {
    // A kind naming an executor nobody registers is refused at boot. An example that could not
    // boot would be a worked example of the wrong thing.
    const { agentKindRegistry, delegatedExecutorRegistry, pipelineRegistry } = registries()
    const problems = collectRegistrationProblems({
      registries: {
        agentKindRegistry,
        gateRegistry: defaultGateRegistry(),
        pipelineRegistry,
        delegatedExecutorRegistry,
      },
    })
    expect(problems.filter((p) => p.code.startsWith('agent_executor'))).toEqual([])
  })

  it('keeps the platform’s own merge tail around the external step', () => {
    // The whole value of a step-level seam: the deployment implements the middle and gets the
    // intake, the policy, the merge and the notifications for free.
    const { pipelineRegistry } = registries()
    const pipeline = pipelineRegistry.registered().find((p) => p.id === 'pl_example_delegated')!
    expect(pipeline.agentKinds).toEqual([EXAMPLE_DELEGATED_KIND, 'merger'])
  })
})

describe('the example executor', () => {
  it('is IDEMPOTENT per correlation key', async () => {
    // A replayed dispatch must re-attach. Two starts is two external runs and two pull requests
    // for one task: the deadliest failure in the seam, and one every executor owns half of.
    const { definition } = exampleDelegatedExecutor()
    const executor = definition.create(deps)
    const brief = {
      correlationKey: 'ex_1-example',
      workspaceId: 'ws',
      blockId: 'blk',
      runId: 'ex_1',
      stepIndex: 0,
      agentKind: EXAMPLE_DELEGATED_KIND,
      task: { id: 'blk', title: 't', description: 'd' },
      repo: { owner: 'acme', name: 'widgets', cloneUrl: 'x', provider: 'github' as const },
      branches: { base: 'main', work: 'cat-factory/blk' },
      systemPrompt: '',
      userPrompt: '',
      contextFiles: [],
      ownService: { stated: false as const, reason: 'not-under-a-service' as const },
    }
    const first = await executor.start(brief, {})
    const replay = await executor.start(brief, {})
    expect(replay).toEqual(first)
  })

  it('runs, then settles with the pull request on the branch the platform named', async () => {
    const { definition } = exampleDelegatedExecutor()
    const executor = definition.create(deps)
    const handle = {
      executor: EXAMPLE_EXECUTOR_ID,
      correlationKey: 'ex_1-example',
      workspaceId: 'ws',
      blockId: 'blk',
      runId: 'ex_1',
      agentKind: EXAMPLE_DELEGATED_KIND,
      branches: { base: 'main', work: 'cat-factory/blk' },
    }
    await executor.start(
      {
        correlationKey: 'ex_1-example',
        workspaceId: 'ws',
        blockId: 'blk',
        runId: 'ex_1',
        stepIndex: 0,
        agentKind: EXAMPLE_DELEGATED_KIND,
        task: { id: 'blk', title: 't', description: 'd' },
        repo: { owner: 'acme', name: 'widgets', cloneUrl: 'x', provider: 'github' },
        branches: { base: 'main', work: 'cat-factory/blk' },
        systemPrompt: '',
        userPrompt: '',
        contextFiles: [],
        ownService: { stated: false, reason: 'not-under-a-service' },
      },
      {},
    )
    expect(await executor.poll(handle, {})).toMatchObject({ state: 'running' })
    await executor.poll(handle, {})
    expect(await executor.poll(handle, {})).toMatchObject({
      state: 'done',
      result: { pullRequest: { branch: 'cat-factory/blk' } },
    })
  })
})
