import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredAgentKinds,
  registerAgentKind,
  registeredKindRequiresContainer,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import type { AgentRunContext, GateContext, ResolverContext } from '@cat-factory/kernel'
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
// real one). The pure-registry tests don't call the seams, so stubs suffice.
const gateCtx = (): GateContext => ({
  clock: { now: () => 0 },
  getBlock: async () => null,
  runInitiatorScope: (_initiatedBy, fn) => fn(),
  raiseNotification: async () => {},
})
const resolverCtx = (): ResolverContext => ({ runInitiatorScope: (_initiatedBy, fn) => fn() })

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
    const def = registered[0]!.factory(gateCtx())
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
    expect(registered[0]!.factory(gateCtx()).helperKind).toBe('fixer-b')
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
    expect(registered[0]!.factory(resolverCtx()).kind).toBe('security-auditor')
  })

  it('replaces an earlier registration of the same kind (last wins)', () => {
    registerStepResolver('x', () => ({ kind: 'x', resolve: async () => ({ output: 'a' }) }))
    registerStepResolver('x', () => ({ kind: 'x', resolve: async () => ({ output: 'b' }) }))
    expect(registeredStepResolverFactories()).toHaveLength(1)
  })
})
