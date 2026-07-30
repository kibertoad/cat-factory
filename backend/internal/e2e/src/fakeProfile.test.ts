import { describe, expect, it } from 'vitest'
import { E2eFakeAgentExecutor, E2eGateProviders, FakeProfileRegistry } from './fakeProfile.ts'

// The e2e backend boots ONCE and serves every spec, so a workspace's fake is built lazily on its
// first call and cached — which means the profile behind it is read exactly once. These pin the
// consequence that a spec depends on: a profile written LATER in a workspace's life still takes
// effect, instead of landing in a map nobody reads again.
//
// That silent no-op is what made `initiative-checkpoint.spec.ts` flaky. It re-arms the one-shot
// decision gate mid-life so the next phase's run PARKS (leaving a stable card to assert on); with
// the write stranded, the run instead auto-merged to `done`, and a `done` task renders no card at
// all. On an idle machine the browser still painted the card before the run settled and the spec
// passed; under CI load the run won, the card never appeared, and the assertion burned its full
// budget on an element that had already been removed. A behavioural assertion (rather than a
// spec-level timing tweak) is the only thing that catches this deterministically.

/** A minimal `AgentRunContext` — only the fields the fake's decision path reads. */
function agentContext(workspaceId: string, stepIndex: number) {
  return {
    workspaceId,
    agentKind: 'architect',
    stepIndex,
    executionId: 'exec_1',
    blockId: 'blk_1',
    block: { id: 'blk_1', title: 'Phase item', description: '' },
  } as unknown as Parameters<E2eFakeAgentExecutor['run']>[0]
}

/** The single fake check run's conclusion for a workspace's current CI script. */
async function conclusion(gates: E2eGateProviders, workspaceId: string): Promise<string | null> {
  const status = await gates.ciStatus.getStatus(workspaceId, 'blk_1')
  return status.repos[0]?.checks[0]?.conclusion ?? null
}

describe('FakeProfileRegistry', () => {
  it('applies a profile written AFTER the workspace has already run an agent call', async () => {
    const registry = new FakeProfileRegistry()
    const executor = new E2eFakeAgentExecutor({}, registry)

    // Seed → run: the workspace's fake is now built and cached, with the gate disabled.
    registry.set('ws_1', { decisionOnSteps: [], confidence: 1 })
    expect((await executor.run(agentContext('ws_1', 0))).decision).toBeUndefined()

    // Re-arm mid-life. Without the registry re-arming the cache this write is a no-op and the
    // next call still reports no decision — the exact shape of the checkpoint-spec flake.
    registry.set('ws_1', { decisionOnSteps: [0] })
    expect((await executor.run(agentContext('ws_1', 0))).decision).toBeDefined()
  })

  it('re-arms only the workspace written to', async () => {
    const registry = new FakeProfileRegistry()
    const executor = new E2eFakeAgentExecutor({}, registry)

    registry.set('ws_1', { decisionOnSteps: [] })
    registry.set('ws_2', { decisionOnSteps: [] })
    await executor.run(agentContext('ws_1', 0))
    await executor.run(agentContext('ws_2', 0))

    registry.set('ws_1', { decisionOnSteps: [0] })
    expect((await executor.run(agentContext('ws_1', 0))).decision).toBeDefined()
    expect((await executor.run(agentContext('ws_2', 0))).decision).toBeUndefined()
  })

  it('re-arms every registered cache, not just the agent executor', async () => {
    const registry = new FakeProfileRegistry()
    const gates = new E2eGateProviders(registry)

    // Build the CI verdict script (a one-entry script repeats its last entry forever).
    registry.set('ws_1', { ciStatus: [true] })
    expect(await conclusion(gates, 'ws_1')).toBe('success')

    // A later write must replace the cached script rather than leave the green one in place.
    registry.set('ws_1', { ciStatus: [false] })
    expect(await conclusion(gates, 'ws_1')).toBe('failure')
  })
})
