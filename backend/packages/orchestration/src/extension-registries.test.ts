import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredAgentKinds,
  registerAgentKind,
  registeredKindRequiresContainer,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import {
  collectRegistrationProblems,
  validateRegistrations,
} from './validation/validateRegistrations.js'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  clearRegisteredGates,
  clearRegisteredPipelines,
  clearRegisteredStepResolvers,
  registerGate,
  registeredGateFactories,
  registerPipeline,
  registerStepResolver,
  registeredStepResolverFactories,
  seedPipelines,
  stubGateContext,
  stubResolverContext,
} from '@cat-factory/kernel'

// The installation-level extension seams that let a deployment (e.g. a proprietary org
// package) mix in custom agent kinds and predefined pipelines, mirroring how
// @cat-factory/provider-bedrock mixes in a model provider.

function ctx(agentKind: string): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'P',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'Widget', type: 'service', description: 'A widget.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
  }
}

describe('agent-kind registry', () => {
  afterEach(() => clearRegisteredAgentKinds())

  it('uses a registered kind’s system prompt over the generic fallback', () => {
    expect(systemPromptFor('org-auditor')).toContain('"org-auditor" agent') // generic fallback
    registerAgentKind({ kind: 'org-auditor', systemPrompt: 'You audit for compliance.' })
    expect(systemPromptFor('org-auditor')).toBe('You audit for compliance.')
  })

  it('supports a function-form system prompt', () => {
    registerAgentKind({ kind: 'org-x', systemPrompt: (kind) => `Role for ${kind}.` })
    expect(systemPromptFor('org-x')).toBe('Role for org-x.')
  })

  it('never shadows a built-in standard-phase kind', () => {
    const before = systemPromptFor('architect')
    registerAgentKind({ kind: 'architect', systemPrompt: 'hijacked' })
    expect(systemPromptFor('architect')).toBe(before)
  })

  it('uses a registered kind’s custom user prompt when provided', () => {
    registerAgentKind({
      kind: 'org-auditor',
      systemPrompt: 'You audit.',
      userPrompt: (c) => `Audit ${c.block.title}`,
    })
    expect(userPromptFor(ctx('org-auditor'))).toBe('Audit Widget')
  })

  it('falls back to the generic user prompt when no builder is given', () => {
    registerAgentKind({ kind: 'org-auditor', systemPrompt: 'You audit.' })
    expect(userPromptFor(ctx('org-auditor'))).toContain('Block: Widget (service)')
  })

  it('reports the container requirement only for kinds that opted in', () => {
    registerAgentKind({ kind: 'org-inline', systemPrompt: 'inline' })
    registerAgentKind({ kind: 'org-repo', systemPrompt: 'repo', requiresContainer: true })
    expect(registeredKindRequiresContainer('org-inline')).toBe(false)
    expect(registeredKindRequiresContainer('org-repo')).toBe(true)
    expect(registeredKindRequiresContainer('coder')).toBe(false) // built-in, not registered
  })

  it('applies surface-driven directives so an author need not reason about them', () => {
    // container-explore: a read-only explore whose deliverable is its reply → BOTH the
    // read-only guardrail AND final-answer-in-reply (this is the gap the consolidation closes —
    // a registered explore kind used to miss the guardrail).
    registerAgentKind({
      kind: 'org-explore',
      systemPrompt: 'You explore.',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
    })
    const explore = systemPromptFor('org-explore')
    expect(explore).toContain('You explore.')
    expect(explore).toContain('READ-ONLY exploration') // READ_ONLY_GUARDRAIL
    expect(explore).toContain('visible content') // FINAL_ANSWER_IN_REPLY

    // inline: deliverable is the reply → final-answer only, no read-only guardrail.
    registerAgentKind({
      kind: 'org-inline2',
      systemPrompt: 'You reply.',
      agent: { surface: 'inline' },
    })
    const inline = systemPromptFor('org-inline2')
    expect(inline).toContain('visible content')
    expect(inline).not.toContain('READ-ONLY exploration')

    // container-coding: product is a pushed commit → neither directive.
    registerAgentKind({
      kind: 'org-coding',
      systemPrompt: 'You code.',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    const coding = systemPromptFor('org-coding')
    expect(coding).toBe('You code.')
  })

  it('does not double-append FINAL_ANSWER_IN_REPLY when a registered id collides with a built-in track', () => {
    // Registering an id that shadows a built-in track (architect = design phase) is allowed; the
    // track prompt wins and already carries FINAL_ANSWER_IN_REPLY. The surface-driven directive
    // logic must NOT re-append it just because the kind is also in the registry → exactly one copy.
    registerAgentKind({
      kind: 'architect',
      systemPrompt: 'Custom architect prompt.',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
    })
    const prompt = systemPromptFor('architect')
    // A once-per-copy phrase from FINAL_ANSWER_IN_REPLY (the directive text repeats "visible
    // content" internally, so that substring is not a per-copy counter).
    const marker = 'Your deliverable is the text of your FINAL reply'
    expect(prompt.split(marker).length - 1).toBe(1)
  })
})

describe('pipeline registry', () => {
  afterEach(() => clearRegisteredPipelines())

  // These assert the registry BEHAVIOUR (append / replace-in-place) against a
  // baseline captured at runtime, not a hardcoded list of built-in ids — so adding
  // or removing a seeded pipeline never churns this file.

  it('seeds the built-in pipelines with unique ids', () => {
    const ids = seedPipelines().map((p) => p.id)
    expect(ids.length).toBeGreaterThan(0)
    // No duplicate ids, so the registry's replace-by-id semantics are unambiguous.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('appends a registered (new-id) pipeline after the built-ins', () => {
    const builtins = seedPipelines().map((p) => p.id)
    registerPipeline({ id: 'pl_org_audit', name: 'Audit & ship', agentKinds: ['org-auditor'] })
    const pipelines = seedPipelines()
    expect(pipelines.map((p) => p.id)).toEqual([...builtins, 'pl_org_audit'])
    expect(pipelines.at(-1)).toEqual({
      id: 'pl_org_audit',
      name: 'Audit & ship',
      agentKinds: ['org-auditor'],
    })
  })

  it('replaces a built-in pipeline in place when ids collide', () => {
    const builtins = seedPipelines().map((p) => p.id)
    expect(builtins).toContain('pl_quick') // precondition: overriding an existing built-in
    registerPipeline({ id: 'pl_quick', name: 'Org quick', agentKinds: ['coder', 'merger'] })
    const pipelines = seedPipelines()
    // Same ids in the same order — replaced in place, not appended.
    expect(pipelines.map((p) => p.id)).toEqual(builtins)
    expect(pipelines.find((p) => p.id === 'pl_quick')?.name).toBe('Org quick')
  })
})

// A throwaway context for invoking a factory in isolation (the ExecutionService builds the
// real one). The pure-registry tests don't call the seams, so the shared kernel stubs suffice.
describe('gate registry', () => {
  afterEach(() => clearRegisteredGates())

  it('exposes a registered gate factory, invokable to a GateDefinition of that kind', () => {
    expect(registeredGateFactories()).toHaveLength(0)
    registerGate('license-check', (ctx) => ({
      kind: 'license-check',
      helperKind: 'license-fixer',
      wired: () => true,
      unwiredOutput: 'skipped',
      probe: async () => ({ status: 'pass', headSha: null }),
      onExhausted: async ({ workspaceId }) => {
        await ctx.raiseNotification(workspaceId, {
          type: 'decision_required',
          blockId: null,
          executionId: null,
          title: 't',
          body: 'b',
        })
        return { error: 'spent' }
      },
    }))
    const registered = registeredGateFactories()
    expect(registered.map((g) => g.kind)).toEqual(['license-check'])
    const def = registered[0]!.factory(stubGateContext())
    expect(def.kind).toBe('license-check')
    expect(def.helperKind).toBe('license-fixer')
  })

  it('replaces an earlier registration of the same kind (last wins)', () => {
    const make = (helperKind: string) => (): ReturnType<Parameters<typeof registerGate>[1]> => ({
      kind: 'license-check',
      helperKind,
      wired: () => true,
      unwiredOutput: 'skipped',
      probe: async () => ({ status: 'pass', headSha: null }),
      onExhausted: async () => ({ error: 'spent' }),
    })
    registerGate('license-check', make('fixer-a'))
    registerGate('license-check', make('fixer-b'))
    const registered = registeredGateFactories()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.factory(stubGateContext()).helperKind).toBe('fixer-b')
  })
})

describe('validateRegistrations', () => {
  afterEach(() => {
    clearRegisteredGates()
    clearRegisteredAgentKinds()
    clearRegisteredPipelines()
  })

  const goodGate = (helperKind: string) => () => ({
    kind: 'license-check',
    helperKind,
    wired: () => true,
    unwiredOutput: 'skipped',
    probe: async () => ({ status: 'pass' as const, headSha: null }),
    onExhausted: async () => ({ error: 'spent' }),
  })

  it('passes when a gate escalates to a registered container-capable helper', () => {
    registerAgentKind({
      kind: 'license-fixer',
      systemPrompt: 'fix',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    registerGate('license-check', goodGate('license-fixer'))
    expect(collectRegistrationProblems()).toEqual([])
    expect(() => validateRegistrations()).not.toThrow()
  })

  it('accepts a built-in helper kind (ci-fixer) without a registered kind', () => {
    registerGate('license-check', goodGate('ci-fixer'))
    expect(collectRegistrationProblems().filter((p) => p.severity === 'error')).toEqual([])
  })

  it('throws when a gate helperKind resolves to nothing', () => {
    registerGate('license-check', goodGate('does-not-exist'))
    const problems = collectRegistrationProblems()
    expect(problems.some((p) => p.code === 'gate_helper_unresolved')).toBe(true)
    expect(() => validateRegistrations()).toThrow(/gate_helper_unresolved/)
  })

  it('rejects a helper that is registered but not container-capable', () => {
    registerAgentKind({ kind: 'inline-helper', systemPrompt: 'x', agent: { surface: 'inline' } })
    registerGate('license-check', goodGate('inline-helper'))
    expect(collectRegistrationProblems().some((p) => p.code === 'gate_helper_unresolved')).toBe(
      true,
    )
  })

  it('errors on an unknown resultView (no silent prose fallback)', () => {
    registerAgentKind({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
      // @ts-expect-error — an unknown view id is exactly what the validator must catch.
      presentation: {
        label: 'Auditor',
        icon: 'i',
        color: '#fff',
        description: 'd',
        resultView: 'no-such-view',
      },
    })
    expect(collectRegistrationProblems().some((p) => p.code === 'unknown_result_view')).toBe(true)
  })

  it('warns (does not throw) when postOps lack structured output', () => {
    registerAgentKind({
      kind: 'render-only',
      systemPrompt: 'x',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
      postOps: [async () => {}],
    })
    const problems = collectRegistrationProblems()
    expect(problems.some((p) => p.code === 'postops_without_structured_output')).toBe(true)
    expect(() => validateRegistrations()).not.toThrow()
  })
})

describe('step-resolver registry', () => {
  afterEach(() => clearRegisteredStepResolvers())

  it('exposes a registered resolver factory, invokable to a resolver of that kind', () => {
    expect(registeredStepResolverFactories()).toHaveLength(0)
    registerStepResolver('security-auditor', () => ({
      kind: 'security-auditor',
      resolve: async () => ({ output: 'done' }),
    }))
    const registered = registeredStepResolverFactories()
    expect(registered.map((r) => r.kind)).toEqual(['security-auditor'])
    expect(registered[0]!.factory(stubResolverContext()).kind).toBe('security-auditor')
  })

  it('replaces an earlier registration of the same kind (last wins)', () => {
    registerStepResolver('x', () => ({ kind: 'x', resolve: async () => ({ output: 'a' }) }))
    registerStepResolver('x', () => ({ kind: 'x', resolve: async () => ({ output: 'b' }) }))
    expect(registeredStepResolverFactories()).toHaveLength(1)
  })
})
