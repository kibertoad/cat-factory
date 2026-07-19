import {
  defaultGateRegistry,
  defaultProviderRegistry,
  defineProviderToken,
  stubGateContext,
  type GateHelperJobResult,
  type ProviderRegistry,
} from '@cat-factory/kernel'
import type {
  Block,
  ExecutionInstance,
  PipelineStep,
  RaiseNotificationInput,
} from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { ciGate, conflictsGate, docQualityGate, postReleaseHealthGate } from './gates.js'
import {
  wireCiStatusProvider,
  wireDocQualityProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
} from './providers.js'
import { gateRegistryWithBuiltins, registerBuiltinGates } from './index.js'

// The built-in gate suite ships as an external package authored through the public seam. These
// tests exercise the wire-handles a deployment copies + the real wired()/probe() paths, plus
// the on-call helper-completion hook — the seam a facade depends on, so a drift fails here.
//
// A fresh provider registry per test (no module global to clear); each gate factory reads it
// through the `stubGateContext(overrides, providerRegistry)` seam, exactly as the engine's
// GateContext reads the injected instance.
let providerRegistry: ProviderRegistry
beforeEach(() => {
  providerRegistry = defaultProviderRegistry()
})

describe('typed provider registry (the gate wiring seam)', () => {
  it('wires/clears an impl and flips isWired', () => {
    const token = defineProviderToken<{ ping: () => string }>('test-provider')
    expect(providerRegistry.isWired(token)).toBe(false)
    providerRegistry.wire(token, { ping: () => 'pong' })
    expect(providerRegistry.isWired(token)).toBe(true)
    expect(providerRegistry.require(token).ping()).toBe('pong')
    providerRegistry.wire(token, undefined)
    expect(providerRegistry.isWired(token)).toBe(false)
  })

  it('require throws on an unwired token (the guard replacing the old `!`)', () => {
    const token = defineProviderToken<unknown>('never-wired')
    expect(() => providerRegistry.require(token)).toThrow(/not wired/)
  })

  it('a gate reads its provider through ctx.requireProvider, not a module global', async () => {
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () => ({
        repos: [
          {
            repo: 'o/r',
            headSha: 'sha',
            checks: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
          },
        ],
      }),
    })
    // The stub context delegates getProvider/requireProvider/isProviderWired to the given registry,
    // so the gate resolves the impl the wireX handle stored — exactly as the engine's GateContext does.
    const gate = ciGate(stubGateContext({}, providerRegistry))
    expect(gate.wired()).toBe(true)
    expect((await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})).status).toBe('pass')
  })
})

describe('@cat-factory/gates registration', () => {
  it('installs ci / conflicts / doc-quality / post-release-health / human-review into an app-owned registry', () => {
    const registry = defaultGateRegistry()
    registerBuiltinGates(registry)
    const kinds = registry
      .factories()
      .map((g) => g.kind)
      .sort()
    expect(kinds).toEqual(['ci', 'conflicts', 'doc-quality', 'human-review', 'post-release-health'])
  })

  it('gateRegistryWithBuiltins() returns a fresh registry pre-loaded with the built-in suite', () => {
    const registry = gateRegistryWithBuiltins()
    const kinds = registry
      .factories()
      .map((g) => g.kind)
      .sort()
    expect(kinds).toEqual(['ci', 'conflicts', 'doc-quality', 'human-review', 'post-release-health'])
    // Fresh instance each call — no shared module state.
    expect(gateRegistryWithBuiltins()).not.toBe(registry)
  })
})

describe('ci gate', () => {
  it('is a pass-through until a provider is wired', () => {
    expect(ciGate(stubGateContext({}, providerRegistry)).wired()).toBe(false)
  })

  it('passes on green CI and fails on red', async () => {
    let green = true
    wireCiStatusProvider(providerRegistry, {
      getStatus: async () => ({
        repos: [
          {
            repo: 'o/r',
            headSha: 'sha',
            checks: [
              {
                name: 'build',
                status: 'completed',
                conclusion: green ? 'success' : 'failure',
                url: null,
              },
            ],
          },
        ],
      }),
    })
    const gate = ciGate(stubGateContext({}, providerRegistry))
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
    wireMergeabilityProvider(providerRegistry, {
      getMergeability: async () => ({ repos: [{ repo: 'o/r', headSha: 'sha', verdict }] }),
    })
    const gate = conflictsGate(stubGateContext({}, providerRegistry))
    expect((await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})).status).toBe('pass')
    verdict = 'conflicted'
    const failed = await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})
    expect(failed.status).toBe('fail')
    // Single-repo: the own repo is the implicit target, so no `conflictTarget` and the fixer
    // is escalatable as usual.
    expect(failed.conflictTarget).toBeUndefined()
    expect(failed.escalatable).toBeUndefined()
  })

  it('escalates a PEER-repo conflict, tagging the peer as the conflict-resolver target', async () => {
    // Multi-repo: own PR is mergeable, the peer PR conflicts. The single-repo conflict-resolver
    // is now dispatched AT the conflicted peer repo (the executor swaps its repo target from
    // `conflictTarget`), so the peer conflict escalates like an own-repo one — the gate records
    // the peer as the conflict target and does NOT decline escalation.
    wireMergeabilityProvider(providerRegistry, {
      getMergeability: async () => ({
        repos: [
          { repo: 'o/own', headSha: 'ownsha', verdict: 'mergeable' },
          { repo: 'o/peer', frameId: 'frm_peer', headSha: 'peersha', verdict: 'conflicted' },
        ],
      }),
    })
    const gate = conflictsGate(stubGateContext({}, providerRegistry))
    const probe = await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})
    expect(probe.status).toBe('fail')
    // No longer declined: a peer conflict escalates to the resolver targeting that peer.
    expect(probe.escalatable).toBeUndefined()
    expect(probe.conflictTarget).toEqual({ repo: 'o/peer', frameId: 'frm_peer' })
    expect(probe.headSha).toBe('peersha')
    expect(probe.headShas).toEqual({ 'o/own': 'ownsha', 'o/peer': 'peersha' })
  })

  it('escalates a conflict on the OWN repo of a multi-repo task', async () => {
    wireMergeabilityProvider(providerRegistry, {
      getMergeability: async () => ({
        repos: [
          { repo: 'o/own', headSha: 'ownsha', verdict: 'conflicted' },
          { repo: 'o/peer', frameId: 'frm_peer', headSha: 'peersha', verdict: 'mergeable' },
        ],
      }),
    })
    const gate = conflictsGate(stubGateContext({}, providerRegistry))
    const probe = await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})
    expect(probe.status).toBe('fail')
    // The own repo IS resolvable by the single-repo resolver → escalate as normal.
    expect(probe.escalatable).toBeUndefined()
    expect(probe.conflictTarget).toEqual({ repo: 'o/own' })
  })
})

describe('doc-quality gate', () => {
  it('is a pass-through until a provider is wired', () => {
    expect(docQualityGate(stubGateContext({}, providerRegistry)).wired()).toBe(false)
  })

  it('passes on a clean document and fails with the findings on a malformed one', async () => {
    let ok = true
    wireDocQualityProvider(providerRegistry, {
      check: async () =>
        ok
          ? { ok: true, headSha: 'sha', path: 'docs/prd/x.md', findings: [] }
          : {
              ok: false,
              headSha: 'sha',
              path: 'docs/prd/x.md',
              findings: ['Missing required section: "Success Metrics".'],
            },
    })
    const gate = docQualityGate(stubGateContext({}, providerRegistry))
    expect(gate.wired()).toBe(true)
    const passed = await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})
    expect(passed.status).toBe('pass')
    expect(passed.passOutput).toContain('docs/prd/x.md')
    ok = false
    const failed = await gate.probe('ws', 'b', {} as PipelineStep['gate'] & {})
    expect(failed.status).toBe('fail')
    expect(failed.failureSummary).toContain('Success Metrics')
    // The failing summary is what the doc-fixer helper is handed.
    expect(gate.helperPriorOutput?.(failed.failureSummary ?? '')?.agentKind).toBe('doc-quality')
  })
})

describe('post-release-health gate on-call completion', () => {
  it('raises a release_regression notification and finishes the gate step', async () => {
    wireReleaseHealthProvider(providerRegistry, {
      probe: async () => ({ status: 'healthy', signals: [] }),
      gatherEvidence: async () => ({ regressedSignals: [], errors: [], notes: '' }),
    })
    const raised: RaiseNotificationInput[] = []
    const gate = postReleaseHealthGate(
      stubGateContext(
        { raiseNotification: async (_ws, input) => void raised.push(input) },
        providerRegistry,
      ),
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
      step: { gate: { regressedSignals: [] } } as unknown as PipelineStep,
      result,
    })
    expect(raised[0]?.type).toBe('release_regression')
    expect(resolution.output).toContain('hold')
  })
})
