import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { FakeAgentExecutor } from './FakeAgentExecutor.js'

/**
 * The fake's fidelity to the REAL result boundary (`toRunResult` → `coerceCustomResult`).
 *
 * There, a structured reply is handed to the kind's own `mapStructuredResult` when it declares
 * one, and surfaces as a raw `custom` only when it does not. The fake owes the same split: it
 * answers each engine-channel kind from a dedicated arm (`mergeAssessment`, `onCallAssessment`,
 * `testReport`, …) and returns `custom` for a deployment's own structured kind.
 *
 * Both halves used to be true by hand: the generic "structured kind → `custom`" branch carried a
 * literal list of the built-ins to stand down for. When the last built-ins were registered, that
 * list did not grow with them, and the generic branch silently captured `merger` and `on-call` —
 * every conformance merge decision arriving as `custom: {ok:true}` instead of the assessment the
 * engine scores, and the post-release-health gate getting no assessment at all. Nothing failed:
 * the suites that exercise those paths configure the assessment through options the shadowed arms
 * were the only readers of.
 *
 * So this asserts the RELATION over the registry rather than a list of kinds: whatever declares a
 * mapper must reach a dedicated arm, and a newly-registered one joins the sweep automatically.
 */

function context(agentKind: string, overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: agentKind as AgentRunContext['agentKind'],
    pipelineName: 'Standard build',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    stepIndex: 0,
    isFinalStep: false,
    block: {
      id: 'blk_1',
      title: 'Add widget',
      type: 'service',
      description: 'Implement the widget feature.',
    },
    resolvedDecision: null,
    priorOutputs: [],
    decisions: [],
    ...overrides,
  }
}

describe('FakeAgentExecutor structured-result channels', () => {
  const registry = defaultAgentKindRegistry()
  const channelKinds = registry
    .all()
    .filter((d) => d.mapStructuredResult !== undefined)
    .map((d) => d.kind)

  it('sweeps a non-empty set of engine-channel kinds', () => {
    // A filter that stopped matching would make every assertion below vacuous.
    expect(channelKinds.length).toBeGreaterThan(0)
  })

  it.each(channelKinds)('never surfaces a raw `custom` for %s', async (kind) => {
    const result = await new FakeAgentExecutor().run(context(kind))
    // `custom` is the channel for a kind the engine reads NOTHING typed from. A kind declaring a
    // mapper is coerced out of it on the real path, so the fake producing one here means the
    // generic branch shadowed the arm that answers this kind.
    expect(result.custom).toBeUndefined()
  })

  it('assesses a merge rather than passing structured JSON through', async () => {
    const high = await new FakeAgentExecutor({ confidence: 1 }).run(
      context('merger', { isFinalStep: true }),
    )
    expect(high.mergeAssessment).toEqual({
      complexity: 0,
      risk: 0,
      impact: 0,
      rationale: 'fake: high confidence',
    })
    // Low confidence is the branch that raises `merge_review` instead of merging, so the two must
    // stay distinguishable: a shadowed arm collapsed both onto one shape.
    const low = await new FakeAgentExecutor({ confidence: 0.1 }).run(
      context('merger', { isFinalStep: true }),
    )
    expect(low.mergeAssessment).toMatchObject({ risk: 1 })
  })

  it('investigates a release regression rather than passing structured JSON through', async () => {
    const result = await new FakeAgentExecutor().run(context('on-call'))
    expect(result.onCallAssessment).toMatchObject({ recommendation: 'hold' })
  })

  it('still surfaces `custom` for a structured kind with no engine channel', async () => {
    const custom = defaultAgentKindRegistry()
    custom.register({
      kind: 'design-doc' as never,
      systemPrompt: 'You write design docs.',
      requiresContainer: true,
      agent: { surface: 'container-explore', output: { kind: 'structured' } },
    })
    const result = await new FakeAgentExecutor({
      agentKindRegistry: custom,
      customResult: { sections: ['overview'] },
    }).run(context('design-doc'))
    expect(result.custom).toEqual({ sections: ['overview'] })
  })
})
