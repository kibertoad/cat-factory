import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  defaultGateRegistry,
  defaultJudgeRegistry,
  defaultPipelineRegistry,
  type GateRegistry,
  type JudgeFactory,
  type JudgeRegistry,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { collectRegistrationProblems } from './validateRegistrations.js'

// Boot-time validation of registered JUDGES (the fourth step-taxonomy bucket). Everything here
// is a misconfiguration that used to surface only mid-run — or, worse, silently.

const scopeJudge: JudgeFactory = () => ({
  kind: 'scope-adherence',
  rubric: { id: 'rubric_scope', name: 'Scope adherence', body: 'Do what was asked.' },
  onFail: 'bounce',
  bounceTargets: ['coder'],
  presentation: {
    label: 'Scope Adherence',
    icon: 'i-lucide-scale',
    color: '#f59e0b',
    description: 'Scores a change against the org scope rule.',
  },
})

function judgesWith(...factories: { kind: string; factory: JudgeFactory }[]): JudgeRegistry {
  const registry = defaultJudgeRegistry()
  for (const { kind, factory } of factories) registry.register(kind, factory)
  return registry
}

function gatesWith(kind: string): GateRegistry {
  const registry = defaultGateRegistry()
  registry.register(kind, () => ({
    kind,
    wired: () => false,
    unwiredOutput: '',
    helperKind: 'ci-fixer',
    probe: async () => ({ status: 'pass' as const, headSha: null }),
    onExhausted: async () => ({ error: 'gave up' }),
  }))
  return registry
}

function collect(opts: {
  judgeRegistry?: JudgeRegistry
  gateRegistry?: GateRegistry
  pipelineKinds?: string[]
}) {
  const pipelineRegistry = defaultPipelineRegistry()
  if (opts.pipelineKinds) {
    pipelineRegistry.register({
      id: 'pl_org_scope',
      name: 'Org build + scope review',
      agentKinds: opts.pipelineKinds,
    })
  }
  return collectRegistrationProblems({
    agentKindRegistry: defaultAgentKindRegistry(),
    gateRegistry: opts.gateRegistry ?? defaultGateRegistry(),
    judgeRegistry: opts.judgeRegistry,
    pipelineRegistry,
    knownAgentKinds: new Set(['coder', 'merger']),
  })
}

describe('validateRegistrations — judges', () => {
  it('accepts a pipeline that places a REGISTERED judge', () => {
    // The worked example's own pipeline. Without the judge registry in the cross-check this was
    // an `error: pipeline_unknown_kind` — the reference implementation failing its own boot gate.
    const problems = collect({
      judgeRegistry: judgesWith({ kind: 'scope-adherence', factory: scopeJudge }),
      pipelineKinds: ['coder', 'scope-adherence', 'merger'],
    })
    expect(problems).toEqual([])
  })

  it('still rejects a pipeline naming a kind nobody registered', () => {
    const problems = collect({
      judgeRegistry: judgesWith({ kind: 'scope-adherence', factory: scopeJudge }),
      pipelineKinds: ['coder', 'not-a-thing'],
    })
    expect(problems.map((p) => p.code)).toEqual(['pipeline_unknown_kind'])
    expect(problems[0]!.message).toContain('not-a-thing')
  })

  it('rejects a judge whose resultView is neither built-in nor namespaced', () => {
    // Unvalidated, a typo here degrades the window to the generic prose panel SILENTLY — the
    // exact failure the same check on agent kinds exists to prevent.
    const problems = collect({
      judgeRegistry: judgesWith({
        kind: 'scope-adherence',
        factory: () => ({
          ...scopeJudge({} as never),
          presentation: { ...scopeJudge({} as never).presentation!, resultView: 'jugde' },
        }),
      }),
    })
    expect(problems.map((p) => p.code)).toEqual(['unknown_result_view'])
    expect(problems[0]!.message).toContain('jugde')
  })

  it('accepts the built-in judge window and a namespaced consumer view', () => {
    for (const resultView of ['judge', 'acme:scope-window']) {
      const problems = collect({
        judgeRegistry: judgesWith({
          kind: 'scope-adherence',
          factory: () => ({
            ...scopeJudge({} as never),
            presentation: { ...scopeJudge({} as never).presentation!, resultView },
          }),
        }),
      })
      expect(problems).toEqual([])
    }
  })

  it('rejects a judge kind that collides with a registered gate', () => {
    // The dispatcher's polling-gate handler has the lower `order`, so the gate silently wins and
    // the judge is dead code. "Disjoint by construction" is only true if something checks.
    const problems = collect({
      judgeRegistry: judgesWith({
        kind: 'ci',
        factory: () => ({ ...scopeJudge({} as never), kind: 'ci' }),
      }),
      gateRegistry: gatesWith('ci'),
    })
    expect(problems.map((p) => p.code)).toContain('judge_gate_kind_collision')
  })

  it('reports a throwing judge factory instead of failing on the first run that reaches it', () => {
    const problems = collect({
      judgeRegistry: judgesWith({
        kind: 'boom',
        factory: () => {
          throw new Error('no provider')
        },
      }),
    })
    expect(problems.map((p) => p.code)).toEqual(['judge_factory_threw'])
    expect(problems[0]!.message).toContain('no provider')
  })

  it('is a no-op for a facade that wires no judge registry at all', () => {
    expect(collect({ pipelineKinds: ['coder', 'merger'] })).toEqual([])
  })
})
