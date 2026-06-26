import {
  clearRegisteredGates,
  defineProviderToken,
  isProviderWired,
  registeredGateFactories,
  requireProvider,
  stubGateContext,
  wireProvider,
  type GateHelperJobResult,
} from '@cat-factory/kernel'
import type {
  Block,
  ExecutionInstance,
  PipelineStep,
  RaiseNotificationInput,
} from '@cat-factory/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { ciGate, conflictsGate, postReleaseHealthGate } from './gates.js'
import {
  clearGateProviders,
  wireCiStatusProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
} from './providers.js'
import { registerBuiltinGates } from './index.js'

// The built-in gate suite ships as an external package authored through the public seam. These
// tests exercise the wire-handles a deployment copies + the real wired()/probe() paths, plus
// the on-call helper-completion hook — the seam a facade depends on, so a drift fails here.

afterEach(() => clearGateProviders())

describe('typed provider registry (the gate wiring seam)', () => {
  it('wires/clears an impl and flips isProviderWired', () => {
    const token = defineProviderToken<{ ping: () => string }>('test-provider')
    expect(isProviderWired(token)).toBe(false)
    wireProvider(token, { ping: () => 'pong' })
    expect(isProviderWired(token)).toBe(true)
    expect(requireProvider(token).ping()).toBe('pong')
    wireProvider(token, undefined)
    expect(isProviderWired(token)).toBe(false)
  })

  it('requireProvider throws on an unwired token (the guard replacing the old `!`)', () => {
    const token = defineProviderToken<unknown>('never-wired')
    expect(() => requireProvider(token)).toThrow(/not wired/)
  })

  it('a gate reads its provider through ctx.requireProvider, not a module global', async () => {
    wireCiStatusProvider({
      getStatus: async () => ({
        headSha: 'sha',
        checks: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
      }),
    })
    // The stub context delegates getProvider/requireProvider to the real registry, so the
    // gate resolves the impl the wireX handle stored — exactly as the engine's GateContext does.
    const gate = ciGate(stubGateContext())
    expect(gate.wired()).toBe(true)
    expect((await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})).status).toBe('pass')
  })
})

describe('@cat-factory/gates registration', () => {
  it('registers ci / conflicts / post-release-health / human-review through the public registry', () => {
    clearRegisteredGates()
    registerBuiltinGates()
    const kinds = registeredGateFactories()
      .map((g) => g.kind)
      .sort()
    expect(kinds).toEqual(['ci', 'conflicts', 'human-review', 'post-release-health'])
  })
})

describe('ci gate', () => {
  it('is a pass-through until a provider is wired', () => {
    expect(ciGate(stubGateContext()).wired()).toBe(false)
  })

  it('passes on green CI and fails on red', async () => {
    let green = true
    wireCiStatusProvider({
      getStatus: async () => ({
        headSha: 'sha',
        checks: [
          {
            name: 'build',
            status: 'completed',
            conclusion: green ? 'success' : 'failure',
            url: null,
          },
        ],
      }),
    })
    const gate = ciGate(stubGateContext())
    expect(gate.wired()).toBe(true)
    expect((await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})).status).toBe('pass')
    green = false
    const failed = await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})
    expect(failed.status).toBe('fail')
    expect(failed.failureSummary).toContain('build')
  })
})

describe('conflicts gate', () => {
  it('passes on a mergeable PR and fails on a conflict', async () => {
    let verdict: 'mergeable' | 'conflicted' = 'mergeable'
    wireMergeabilityProvider({
      getMergeability: async () => ({ headSha: 'sha', verdict }),
    })
    const gate = conflictsGate(stubGateContext())
    expect((await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})).status).toBe('pass')
    verdict = 'conflicted'
    expect((await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})).status).toBe('fail')
  })
})

describe('post-release-health gate on-call completion', () => {
  it('raises a release_regression notification and finishes the gate step', async () => {
    wireReleaseHealthProvider({
      probe: async () => ({ status: 'healthy', signals: [] }),
      gatherEvidence: async () => ({ regressedSignals: [], errors: [], notes: '' }),
    })
    const raised: RaiseNotificationInput[] = []
    const gate = postReleaseHealthGate(
      stubGateContext({ raiseNotification: async (_ws, input) => void raised.push(input) }),
    )
    const result: GateHelperJobResult = {
      state: 'done',
      result: {
        output: '',
        onCallAssessment: {
          culpritConfidence: 0.8,
          recommendation: 'hold',
          rationale: 'looks related',
          evidence: [],
        },
      },
    }
    const resolution = await gate.resolveHelperCompletion!({
      workspaceId: 'ws',
      instance: { id: 'ex', pipelineName: 'Build' } as ExecutionInstance,
      block: { id: 'b', title: 'Login' } as Block,
      step: { gate: { regressedSignals: [] } } as PipelineStep,
      result,
    })
    expect(raised[0]?.type).toBe('release_regression')
    expect(resolution.output).toContain('hold')
  })
})
