import { beforeEach, describe, expect, it } from 'vitest'
import {
  AgentKindRegistry,
  defaultAgentKindRegistry,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import {
  collectRegistrationProblems,
  validateRegistrations,
} from './validation/validateRegistrations.js'
import type { AgentRunContext, GateRegistry } from '@cat-factory/kernel'
import {
  defaultGateRegistry,
  defaultPipelineRegistry,
  defaultStepResolverRegistry,
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
  // App-owned DI: each test news a fresh registry (built-ins pre-loaded) — no global to clear.
  let registry: AgentKindRegistry
  beforeEach(() => {
    registry = defaultAgentKindRegistry()
  })

  it('uses a registered kind’s system prompt over the generic fallback', () => {
    expect(systemPromptFor('org-auditor', registry)).toContain('"org-auditor" agent') // generic fallback
    registry.register({ kind: 'org-auditor', systemPrompt: 'You audit for compliance.' })
    expect(systemPromptFor('org-auditor', registry)).toBe('You audit for compliance.')
  })

  it('supports a function-form system prompt', () => {
    registry.register({ kind: 'org-x', systemPrompt: (kind) => `Role for ${kind}.` })
    expect(systemPromptFor('org-x', registry)).toBe('Role for org-x.')
  })

  it('never shadows a built-in standard-phase kind', () => {
    const before = systemPromptFor('architect', registry)
    registry.register({ kind: 'architect', systemPrompt: 'hijacked' })
    expect(systemPromptFor('architect', registry)).toBe(before)
  })

  it('uses a registered kind’s custom user prompt when provided', () => {
    registry.register({
      kind: 'org-auditor',
      systemPrompt: 'You audit.',
      userPrompt: (c) => `Audit ${c.block.title}`,
    })
    expect(userPromptFor(ctx('org-auditor'), registry)).toBe('Audit Widget')
  })

  it('falls back to the generic user prompt when no builder is given', () => {
    registry.register({ kind: 'org-auditor', systemPrompt: 'You audit.' })
    expect(userPromptFor(ctx('org-auditor'), registry)).toContain('Block: Widget (service)')
  })

  it('reports the container requirement only for kinds that opted in', () => {
    registry.register({ kind: 'org-inline', systemPrompt: 'inline' })
    registry.register({ kind: 'org-repo', systemPrompt: 'repo', requiresContainer: true })
    expect(registry.requiresContainer('org-inline')).toBe(false)
    expect(registry.requiresContainer('org-repo')).toBe(true)
    expect(registry.requiresContainer('coder')).toBe(false) // built-in, not registered
  })

  it('applies surface-driven directives so an author need not reason about them', () => {
    // container-explore: a read-only explore whose deliverable is its reply → BOTH the
    // read-only guardrail AND final-answer-in-reply (this is the gap the consolidation closes —
    // a registered explore kind used to miss the guardrail).
    registry.register({
      kind: 'org-explore',
      systemPrompt: 'You explore.',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
    })
    const explore = systemPromptFor('org-explore', registry)
    expect(explore).toContain('You explore.')
    expect(explore).toContain('READ-ONLY exploration') // READ_ONLY_GUARDRAIL
    expect(explore).toContain('visible content') // FINAL_ANSWER_IN_REPLY

    // inline: deliverable is the reply → final-answer only, no read-only guardrail.
    registry.register({
      kind: 'org-inline2',
      systemPrompt: 'You reply.',
      agent: { surface: 'inline' },
    })
    const inline = systemPromptFor('org-inline2', registry)
    expect(inline).toContain('visible content')
    expect(inline).not.toContain('READ-ONLY exploration')

    // container-coding: product is a pushed commit → neither directive.
    registry.register({
      kind: 'org-coding',
      systemPrompt: 'You code.',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    const coding = systemPromptFor('org-coding', registry)
    expect(coding).toBe('You code.')
  })

  it('does not double-append FINAL_ANSWER_IN_REPLY when a registered id collides with a built-in track', () => {
    // Registering an id that shadows a built-in track (architect = design phase) is allowed; the
    // track prompt wins and already carries FINAL_ANSWER_IN_REPLY. The surface-driven directive
    // logic must NOT re-append it just because the kind is also in the registry → exactly one copy.
    registry.register({
      kind: 'architect',
      systemPrompt: 'Custom architect prompt.',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
    })
    const prompt = systemPromptFor('architect', registry)
    // A once-per-copy phrase from FINAL_ANSWER_IN_REPLY (the directive text repeats "visible
    // content" internally, so that substring is not a per-copy counter).
    const marker = 'Your deliverable is the text of your FINAL reply'
    expect(prompt.split(marker).length - 1).toBe(1)
  })
})

describe('pipeline registry', () => {
  // App-owned DI: each test news a fresh (empty) registry — no module global to clear.
  // These assert the registry BEHAVIOUR (append / replace-in-place) against a baseline captured
  // at runtime, not a hardcoded list of built-in ids — so adding or removing a seeded pipeline
  // never churns this file.

  it('seeds the built-in pipelines with unique ids', () => {
    const ids = seedPipelines().map((p) => p.id)
    expect(ids.length).toBeGreaterThan(0)
    // No duplicate ids, so the registry's replace-by-id semantics are unambiguous.
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('appends a registered (new-id) pipeline after the built-ins', () => {
    const builtins = seedPipelines().map((p) => p.id)
    const registry = defaultPipelineRegistry()
    registry.register({ id: 'pl_org_audit', name: 'Audit & ship', agentKinds: ['org-auditor'] })
    const pipelines = seedPipelines(registry)
    expect(pipelines.map((p) => p.id)).toEqual([...builtins, 'pl_org_audit'])
    expect(pipelines.at(-1)).toEqual({
      id: 'pl_org_audit',
      name: 'Audit & ship',
      agentKinds: ['org-auditor'],
    })
  })

  it('replaces a built-in pipeline in place when ids collide', () => {
    const builtins = seedPipelines().map((p) => p.id)
    expect(builtins).toContain('pl_simple') // precondition: overriding an existing built-in
    const registry = defaultPipelineRegistry()
    registry.register({ id: 'pl_simple', name: 'Org quick', agentKinds: ['coder', 'merger'] })
    const pipelines = seedPipelines(registry)
    // Same ids in the same order — replaced in place, not appended.
    expect(pipelines.map((p) => p.id)).toEqual(builtins)
    expect(pipelines.find((p) => p.id === 'pl_simple')?.name).toBe('Org quick')
  })
})

// A throwaway context for invoking a factory in isolation (the ExecutionService builds the
// real one). The pure-registry tests don't call the seams, so the shared kernel stubs suffice.
describe('gate registry', () => {
  // App-owned DI: each test news a fresh (empty) registry — no module global to clear.
  it('exposes a registered gate factory, invokable to a GateDefinition of that kind', () => {
    const registry = defaultGateRegistry()
    expect(registry.factories()).toHaveLength(0)
    registry.register('license-check', (ctx) => ({
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
    const registered = registry.factories()
    expect(registered.map((g) => g.kind)).toEqual(['license-check'])
    const def = registered[0]!.factory(stubGateContext())
    expect(def.kind).toBe('license-check')
    expect(def.helperKind).toBe('license-fixer')
  })

  it('replaces an earlier registration of the same kind (last wins)', () => {
    const registry = defaultGateRegistry()
    const make =
      (helperKind: string) => (): ReturnType<Parameters<typeof registry.register>[1]> => ({
        kind: 'license-check',
        helperKind,
        wired: () => true,
        unwiredOutput: 'skipped',
        probe: async () => ({ status: 'pass', headSha: null }),
        onExhausted: async () => ({ error: 'spent' }),
      })
    registry.register('license-check', make('fixer-a'))
    registry.register('license-check', make('fixer-b'))
    const registered = registry.factories()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.factory(stubGateContext()).helperKind).toBe('fixer-b')
  })
})

describe('validateRegistrations', () => {
  // A fresh, EMPTY registry per test (the built-ins would trip the "postOps without structured
  // output" heuristic etc.), injected into the validator via its `agentKindRegistry` option.
  // The gate registry is likewise a fresh app-owned instance per test.
  let registry: AgentKindRegistry
  let gates: GateRegistry
  beforeEach(() => {
    registry = new AgentKindRegistry()
    gates = defaultGateRegistry()
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
    registry.register({
      kind: 'license-fixer',
      systemPrompt: 'fix',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    gates.register('license-check', goodGate('license-fixer'))
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }),
    ).toEqual([])
    expect(() =>
      validateRegistrations({ agentKindRegistry: registry, gateRegistry: gates }),
    ).not.toThrow()
  })

  it('accepts a built-in helper kind (ci-fixer) without a registered kind', () => {
    gates.register('license-check', goodGate('ci-fixer'))
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).filter(
        (p) => p.severity === 'error',
      ),
    ).toEqual([])
  })

  it('throws when a gate helperKind resolves to nothing', () => {
    gates.register('license-check', goodGate('does-not-exist'))
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.some((p) => p.code === 'gate_helper_unresolved')).toBe(true)
    expect(() =>
      validateRegistrations({ agentKindRegistry: registry, gateRegistry: gates }),
    ).toThrow(/gate_helper_unresolved/)
  })

  it('rejects a helper that is registered but not container-capable', () => {
    registry.register({ kind: 'inline-helper', systemPrompt: 'x', agent: { surface: 'inline' } })
    gates.register('license-check', goodGate('inline-helper'))
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).some(
        (p) => p.code === 'gate_helper_unresolved',
      ),
    ).toBe(true)
  })

  it('errors on a skill / tool-server id with no registration', () => {
    // The failure this catches is invisible at run time: the agent simply works without the
    // playbook or the tool it was supposed to have, and the output is merely worse.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      skills: ['never-registered'],
      toolServers: ['also-never-registered'],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.some((p) => p.code === 'unknown_bundled_skill')).toBe(true)
    expect(problems.some((p) => p.code === 'unknown_tool_server')).toBe(true)
  })

  it('errors on a malformed MCP server id', () => {
    // The id becomes part of the tool names the CLI exposes AND a Codex TOML key, so a bad one
    // fails deep inside the CLI, far from the registration that caused it.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [{ id: 'Bad Id', transport: { kind: 'stdio', command: 'x' } }],
    })
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).some(
        (p) => p.code === 'invalid_tool_server_id',
      ),
    ).toBe(true)
  })

  it('warns (not errors) when tool servers are declared on a non-container kind', () => {
    // An inline LLM step has no agent CLI to wire them into, so they can never take effect — but a
    // deployment may declare them ahead of moving the kind onto a container surface.
    registry.register({
      kind: 'inline-auditor',
      systemPrompt: 'audit',
      agent: { surface: 'inline' },
      toolServers: [{ id: 'issues', transport: { kind: 'stdio', command: 'x' } }],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.find((p) => p.code === 'tool_servers_without_container')?.severity).toBe('warn')
    expect(() =>
      validateRegistrations({ agentKindRegistry: registry, gateRegistry: gates }),
    ).not.toThrow()
  })

  it('warns (not errors) when SKILLS are declared on a non-container kind', () => {
    // Symmetric with tool servers, and for the same reason: only a container dispatch installs a
    // skill and folds its instructions into the prompt, so an inline kind's declaration is inert.
    // Left un-warned, a non-optional `{ catalogSkillId }` here is worse than inert — it fails
    // EVERY dispatch of the kind on a deployment with no skill library, for a skill that could
    // never have reached the model anyway.
    registry.register({
      kind: 'inline-reviewer',
      systemPrompt: 'review',
      agent: { surface: 'inline' },
      skills: [{ catalogSkillId: 'src:acme:house-style' }],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.find((p) => p.code === 'skills_without_container')?.severity).toBe('warn')
    expect(() =>
      validateRegistrations({ agentKindRegistry: registry, gateRegistry: gates }),
    ).not.toThrow()
  })

  it('rejects a cleartext http tool-server endpoint off loopback', () => {
    // An HTTP tool server carries its resolved credential in a request header. The harness refuses
    // the same URL at the job boundary; erroring HERE puts the failure next to the registration
    // that caused it instead of deep in a container.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [{ id: 'docs', transport: { kind: 'http', url: 'http://mcp.example.com/sse' } }],
    })
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).some(
        (p) => p.code === 'insecure_tool_server_url',
      ),
    ).toBe(true)
  })

  it('accepts an https endpoint, and a plain-http one on loopback', () => {
    // A server running beside the agent in its own container has no certificate to present.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [
        { id: 'docs', transport: { kind: 'http', url: 'https://mcp.example.com/sse' } },
        { id: 'sidecar', transport: { kind: 'http', url: 'http://127.0.0.1:8080/mcp' } },
      ],
    })
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).some(
        (p) => p.code === 'insecure_tool_server_url',
      ),
    ).toBe(false)
  })

  it('accepts registered + inline capabilities on a container kind', () => {
    registry.registerSkill({
      id: 'house-review',
      name: 'house-review',
      description: 'd',
      instructions: 'i',
    })
    registry.registerToolServer({ id: 'issues', transport: { kind: 'stdio', command: 'x' } })
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      skills: ['house-review', { catalogSkillId: 'src:s:triage' }],
      toolServers: ['issues', { id: 'docs', transport: { kind: 'http', url: 'https://x/mcp' } }],
    })
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }),
    ).toEqual([])
  })

  it('errors on an unknown resultView (no silent prose fallback)', () => {
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
      presentation: {
        label: 'Auditor',
        icon: 'i',
        color: '#fff',
        description: 'd',
        // A bare id that is neither a built-in nor namespaced — exactly the typo the validator catches.
        resultView: 'no-such-view',
      },
    })
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).some(
        (p) => p.code === 'unknown_result_view',
      ),
    ).toBe(true)
  })

  it('accepts a consumer-namespaced resultView id (paired to a deployment component on the SPA)', () => {
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
      presentation: {
        label: 'Auditor',
        icon: 'i',
        color: '#fff',
        description: 'd',
        resultView: 'acme:security-report',
      },
    })
    expect(
      collectRegistrationProblems({ agentKindRegistry: registry, gateRegistry: gates }).some(
        (p) => p.code === 'unknown_result_view',
      ),
    ).toBe(false)
  })

  it('warns (does not throw) when postOps lack structured output', () => {
    registry.register({
      kind: 'render-only',
      systemPrompt: 'x',
      agent: { surface: 'container-explore', clone: { branch: 'pr' } },
      postOps: [async () => {}],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.some((p) => p.code === 'postops_without_structured_output')).toBe(true)
    expect(() =>
      validateRegistrations({ agentKindRegistry: registry, gateRegistry: gates }),
    ).not.toThrow()
  })

  // A `retire()` call that names a still-live pipeline does NOTHING — `retiredPipelines` keeps a
  // live pipeline over a tombstone for it, so a deployment cannot withdraw the curated built-ins.
  // That is deliberate; being silent about it is not, and boot is the last point where the author
  // can act. These pin that the check fires on the inert case and stays quiet on the two valid ones.
  it('errors on a retirement that names a pipeline the live catalog still ships', () => {
    const pipelines = defaultPipelineRegistry()
    pipelines.retire('pl_full')
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
      pipelineRegistry: pipelines,
    })
    const problem = problems.find((p) => p.code === 'retirement_of_live_pipeline')
    expect(problem?.severity).toBe('error')
    expect(problem?.message).toContain('pl_full')
    expect(() =>
      validateRegistrations({
        agentKindRegistry: registry,
        gateRegistry: gates,
        pipelineRegistry: pipelines,
      }),
    ).toThrow()
  })

  it('accepts a retirement whose id nothing currently defines', () => {
    // The INTENDED use: a tombstone for a pipeline an older version of the deployment's own package
    // shipped. Its definition is long gone from their code — reaching the boards that still store
    // the row is the entire point, so flagging this would refuse the feature's main case.
    const pipelines = defaultPipelineRegistry()
    pipelines.retire('pl_org_flow_v1', { replacedBy: 'pl_full' })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: registry,
        gateRegistry: gates,
        pipelineRegistry: pipelines,
      }).some((p) => p.code === 'retirement_of_live_pipeline'),
    ).toBe(false)
  })

  it('accepts retiring a pipeline the SAME registry had registered', () => {
    // `retire` drops the registration, so the id is no longer live and the tombstone stands.
    const pipelines = defaultPipelineRegistry()
    pipelines.register({ id: 'pl_org_flow', name: 'Org flow', agentKinds: ['coder'] })
    pipelines.retire('pl_org_flow')
    expect(
      collectRegistrationProblems({
        agentKindRegistry: registry,
        gateRegistry: gates,
        pipelineRegistry: pipelines,
      }).some((p) => p.code === 'retirement_of_live_pipeline'),
    ).toBe(false)
  })
})

describe('step-resolver registry', () => {
  // App-owned DI: each test news a fresh (empty) registry — no module global to clear.
  it('exposes a registered resolver factory, invokable to a resolver of that kind', () => {
    const registry = defaultStepResolverRegistry()
    expect(registry.factories()).toHaveLength(0)
    registry.register('security-auditor', () => ({
      kind: 'security-auditor',
      resolve: async () => ({ output: 'done' }),
    }))
    const registered = registry.factories()
    expect(registered.map((r) => r.kind)).toEqual(['security-auditor'])
    expect(registered[0]!.factory(stubResolverContext()).kind).toBe('security-auditor')
  })

  it('replaces an earlier registration of the same kind (last wins)', () => {
    const registry = defaultStepResolverRegistry()
    registry.register('x', () => ({ kind: 'x', resolve: async () => ({ output: 'a' }) }))
    registry.register('x', () => ({ kind: 'x', resolve: async () => ({ output: 'b' }) }))
    expect(registry.factories()).toHaveLength(1)
  })
})
