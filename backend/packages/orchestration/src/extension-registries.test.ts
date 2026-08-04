import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentKindRegistry,
  defaultAgentKindRegistry,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import {
  clearRegisteredPromptFragments,
  registerPromptFragment,
} from '@cat-factory/prompt-fragments'
import {
  collectRegistrationProblems,
  validateRegistrations,
} from './validation/validateRegistrations.js'
import type { AgentRunContext, CustomTaskType, GateRegistry } from '@cat-factory/kernel'
import {
  defaultBinaryGeneratorRegistry,
  defaultFoundationalServiceRegistry,
  defaultGateRegistry,
  defaultPipelineRegistry,
  defaultStepResolverRegistry,
  defaultTaskTypeRegistry,
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
    expect(systemPromptFor('org-auditor', registry)).toContain('You audit for compliance.')
    expect(systemPromptFor('org-auditor', registry)).not.toContain('"org-auditor" agent')
  })

  it('supports a function-form system prompt', () => {
    registry.register({ kind: 'org-x', systemPrompt: (kind) => `Role for ${kind}.` })
    expect(systemPromptFor('org-x', registry)).toContain('Role for org-x.')
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
    expect(coding).toContain('You code.')
    expect(coding).not.toContain('visible content')
    expect(coding).not.toContain('READ-ONLY exploration')
  })

  it('tells EVERY kind that the platform running it is not the product, whatever its surface', () => {
    // Unconditional, unlike the surface directives: any kind can see the orchestrator's mechanics
    // (its branch names, its `.cat-*` files), and a task with no product context of its own leaves
    // the platform's name as the most salient subject in the prompt.
    registry.register({
      kind: 'org-coding3',
      systemPrompt: 'You code.',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    registry.register({
      kind: 'org-inline3',
      systemPrompt: 'You reply.',
      agent: { surface: 'inline' },
    })
    for (const kind of ['org-coding3', 'org-inline3', 'coder', 'architect', 'merger']) {
      expect(systemPromptFor(kind, registry)).toContain('IS NOT THE PRODUCT YOU WORK ON')
    }
  })

  it('keeps the platform/product boundary on a prompt a workspace overrode', () => {
    registry.register({
      kind: 'org-inline4',
      systemPrompt: 'You reply.',
      agent: { surface: 'inline' },
    })
    const overridden = systemPromptFor('org-inline4', registry, 'Be someone else entirely.')
    expect(overridden).toContain('Be someone else entirely.')
    expect(overridden).not.toContain('You reply.')
    expect(overridden).toContain('IS NOT THE PRODUCT YOU WORK ON')
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

  it('rejects a tool-server credential naming a PLATFORM configuration variable', () => {
    // The generative-integration half of this rule is enforced by its credential SCHEMA; a tool
    // server is a TypeScript registration with no schema, so boot validation is where the same
    // floor is stated for it. Without it, `{ key: 'ENCRYPTION_KEY', header: 'Authorization' }`
    // was a registration that booted clean and shipped the deployment's master sealing key to
    // whatever host the transport named.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [
        {
          id: 'docs',
          transport: { kind: 'http', url: 'https://mcp.example.com/sse' },
          secretKeys: [{ key: 'ENCRYPTION_KEY', header: 'Authorization' }],
        },
      ],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.some((p) => p.code === 'reserved_credential_key')).toBe(true)
  })

  it('accepts an injection name inside a reserved platform FAMILY', () => {
    // The escape the reserved floor needs, and the reason the floor can stay as broad as it is:
    // the GitHub MCP server's own client reads `GITHUB_PERSONAL_ACCESS_TOKEN`, which the platform
    // does not read and cannot rename for it.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [
        {
          id: 'github',
          transport: { kind: 'stdio', command: 'github-mcp' },
          secretKeys: [{ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }],
        },
      ],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.some((p) => p.code === 'reserved_credential_key')).toBe(false)
    expect(problems.some((p) => p.code === 'toolchain_credential_env_name')).toBe(false)
  })

  it('rejects a TOOLCHAIN injection name, which reconfigures the server process', () => {
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [
        {
          id: 'docs',
          transport: { kind: 'stdio', command: 'docs-mcp' },
          secretKeys: [{ key: 'DOCS_TOKEN', envName: 'LD_PRELOAD' }],
        },
      ],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    expect(problems.some((p) => p.code === 'toolchain_credential_env_name')).toBe(true)
  })

  it('warns when an injection name is declared on a key that names a HEADER', () => {
    // An http server sends its value as that header, so the injection name is read by nothing. A
    // warning rather than an error: the declaration works, it just says something inert.
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [
        {
          id: 'docs',
          transport: { kind: 'http', url: 'https://mcp.example.com/sse' },
          secretKeys: [{ key: 'DOCS_TOKEN', header: 'Authorization', envName: 'DOCS_ENV' }],
        },
      ],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: registry,
      gateRegistry: gates,
    })
    const warning = problems.find((p) => p.code === 'unused_credential_env_name')
    expect(warning?.severity).toBe('warn')
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

describe('agent-kind variant validation', () => {
  const gates = defaultGateRegistry()

  /** A registry carrying one variant of the BUILT-IN `coder`, as a deployment package ships it. */
  function withCoderVariant() {
    const registry = defaultAgentKindRegistry()
    registry.registerVariant({ id: 'org:tdd', baseKind: 'coder', promptAddition: 'test-first' })
    return registry
  }

  it('accepts a variant of a known built-in kind', () => {
    expect(
      collectRegistrationProblems({
        agentKindRegistry: withCoderVariant(),
        gateRegistry: gates,
        knownAgentKinds: new Set(['coder']),
      }),
    ).toEqual([])
  })

  it('reports a variant of a kind nothing registers — no step could ever select it', () => {
    const registry = defaultAgentKindRegistry()
    registry.registerVariant({ id: 'org:tdd', baseKind: 'ghost', promptAddition: 'x' })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: registry,
        gateRegistry: gates,
        knownAgentKinds: new Set(['coder']),
      }).some((p) => p.code === 'variant_unknown_base_kind'),
    ).toBe(true)
  })

  it('reports a variant that changes no text — it runs as the stock kind, silently', () => {
    const registry = defaultAgentKindRegistry()
    registry.registerVariant({ id: 'org:noop', baseKind: 'coder' })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: registry,
        gateRegistry: gates,
        knownAgentKinds: new Set(['coder']),
      }).some((p) => p.code === 'variant_changes_nothing'),
    ).toBe(true)
  })

  it('reports a variant of an INLINE-ENGINE kind, which no step could ever apply', () => {
    // Those kinds are driven as bare inline calls whose prompt is composed from (workspace, kind)
    // with no step, so the variant is unreachable. Boot is where a deployment should hear it.
    const registry = defaultAgentKindRegistry()
    registry.registerVariant({
      id: 'org:strict',
      baseKind: 'requirements-review',
      promptAddition: 'Be strict.',
    })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: registry,
        gateRegistry: gates,
        knownAgentKinds: new Set(['coder', 'requirements-review']),
      }).some((p) => p.code === 'variant_inline_engine_kind'),
    ).toBe(true)
  })

  it('accepts a variant of a bespoke-prompt CONTAINER kind, which does dispatch through the engine', () => {
    const registry = defaultAgentKindRegistry()
    registry.registerVariant({
      id: 'org:cautious',
      baseKind: 'merger',
      promptAddition: 'Weigh migrations as high risk.',
    })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: registry,
        gateRegistry: gates,
        knownAgentKinds: new Set(['coder', 'merger']),
      }),
    ).toEqual([])
  })

  it('reports a REGISTERED pipeline whose step selects a variant of another kind', () => {
    const pipelines = defaultPipelineRegistry()
    pipelines.register({
      id: 'pl_org_flow',
      name: 'Org flow',
      agentKinds: ['architect', 'coder'],
      stepOptions: [{ agentVariantId: 'org:tdd' }, null],
    })
    const problems = collectRegistrationProblems({
      agentKindRegistry: withCoderVariant(),
      gateRegistry: gates,
      pipelineRegistry: pipelines,
      knownAgentKinds: new Set(['architect', 'coder']),
    })
    expect(problems.some((p) => p.code === 'pipeline_variant_unresolved')).toBe(true)
  })

  it('imposes no requirement on a DISABLED step of a registered pipeline', () => {
    // Boot must apply exactly the rule the builder applies (`assertValidAgentVariants` skips a
    // disabled step), or the same shape would be valid or invalid depending on which door it
    // came through — refused in code, accepted through the API.
    const pipelines = defaultPipelineRegistry()
    pipelines.register({
      id: 'pl_org_flow',
      name: 'Org flow',
      agentKinds: ['architect', 'coder'],
      enabled: [false, true],
      stepOptions: [{ agentVariantId: 'org:tdd' }, null],
    })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: withCoderVariant(),
        gateRegistry: gates,
        pipelineRegistry: pipelines,
        knownAgentKinds: new Set(['architect', 'coder']),
      }),
    ).toEqual([])
  })

  it('accepts a REGISTERED pipeline selecting a variant of the right step kind', () => {
    const pipelines = defaultPipelineRegistry()
    pipelines.register({
      id: 'pl_org_flow',
      name: 'Org flow',
      agentKinds: ['architect', 'coder'],
      stepOptions: [null, { agentVariantId: 'org:tdd' }],
    })
    expect(
      collectRegistrationProblems({
        agentKindRegistry: withCoderVariant(),
        gateRegistry: gates,
        pipelineRegistry: pipelines,
        knownAgentKinds: new Set(['architect', 'coder']),
      }),
    ).toEqual([])
  })
})

describe('foundational-service registry validation', () => {
  const gates = defaultGateRegistry()
  const kinds = defaultAgentKindRegistry()
  const problemsFor = (
    definitions: Parameters<ReturnType<typeof defaultFoundationalServiceRegistry>['register']>[0][],
  ) => {
    const foundationalServiceRegistry = defaultFoundationalServiceRegistry()
    foundationalServiceRegistry.registerAll(definitions)
    return collectRegistrationProblems({
      agentKindRegistry: kinds,
      gateRegistry: gates,
      foundationalServiceRegistry,
    }).filter((p) => p.code === 'foundational_service_invalid')
  }

  const valid = {
    id: 'file-storage',
    name: 'File Storage',
    summary: 'Stores uploads.',
    description: '',
    capabilities: ['asset-storage'],
    contracts: [
      {
        contractId: 'http',
        format: 'openapi' as const,
        title: 'HTTP API',
        body: 'openapi: 3.0.3\npaths:\n  /files:\n    get: {}\n',
      },
    ],
  }

  it('passes a definition the REST write boundary would have accepted', () => {
    expect(problemsFor([valid])).toEqual([])
  })

  it('fails boot on an id the write boundary would refuse', () => {
    // Registering in code has no moment of refusal of its own; boot is that moment, or the
    // deployment ships a service an Architect can never resolve.
    const problems = problemsFor([{ ...valid, id: 'File Storage' }])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.message).toContain('lower-kebab')
  })

  it('fails boot on a contract document that is not what it claims to be', () => {
    const problems = problemsFor([
      { ...valid, contracts: [{ ...valid.contracts[0]!, body: 'this is not a spec' }] },
    ])
    expect(problems[0]?.message).toContain('not a valid OpenAPI')
  })

  it('fails boot on a capability tag that near-misses the enforced one', () => {
    // The failure it replaces: `asset_storage` registers, and a binary-output run is refused
    // hours later with `not_storage_capable`.
    const problems = problemsFor([{ ...valid, capabilities: ['asset_storage'] }])
    expect(problems[0]?.message).toContain("'asset-storage'")
  })

  it('reports a malformed definition ONCE rather than restating it as several', () => {
    expect(problemsFor([{ ...valid, id: 'Bad Id', capabilities: ['asset_storage'] }])).toHaveLength(
      1,
    )
  })
})

describe('generative binary integration registry validation', () => {
  const gates = defaultGateRegistry()
  const kinds = defaultAgentKindRegistry()
  const problemsFor = (
    definitions: Parameters<ReturnType<typeof defaultBinaryGeneratorRegistry>['register']>[0][],
  ) => {
    const binaryGeneratorRegistry = defaultBinaryGeneratorRegistry()
    binaryGeneratorRegistry.registerAll(definitions)
    return collectRegistrationProblems({
      agentKindRegistry: kinds,
      gateRegistry: gates,
      binaryGeneratorRegistry,
    }).filter((p) => p.code.startsWith('binary_generator') || p.code.endsWith('generator_endpoint'))
  }

  const valid = {
    id: 'retro-diffusion',
    name: 'Retro Diffusion',
    summary: 'Pixel-art image generation.',
    description: 'Sprites and tiles; not photorealism.',
    modalities: ['image' as const],
    mediaTypes: ['image/png'],
    endpoint: 'https://api.retrodiffusion.ai/v1',
    credential: { key: 'RD_TOKEN', usage: 'the X-RD-Token header' },
  }

  it('passes a well-formed registration', () => {
    expect(problemsFor([valid])).toEqual([])
  })

  it('fails boot on a credential key that is not a usable environment variable name', () => {
    // The failure it replaces: the harness drops the malformed name at parse and the integration
    // 401s mid-run, naming nothing that points back at the registration.
    const problems = problemsFor([{ ...valid, credential: { key: 'x-rd-token' } }])
    expect(problems[0]?.message).toContain('environment variable name')
  })

  it('fails boot on a credential naming a PLATFORM configuration variable', () => {
    // A definition names both the key it wants and the endpoint that key is sent to, so this is a
    // registration that booted clean and shipped the deployment's master sealing key to a third
    // party. Enforced by the credential SCHEMA, so it reaches boot through the same parse.
    const problems = problemsFor([{ ...valid, credential: { key: 'ENCRYPTION_KEY' } }])
    expect(problems[0]?.code).toBe('binary_generator_invalid')
    expect(problems[0]?.message).toContain('the platform')
    // Case-insensitively, because `process.env` lookup is on Windows.
    expect(problemsFor([{ ...valid, credential: { key: 'encryption_key' } }])).toHaveLength(1)
  })

  it('fails boot on a cleartext endpoint off loopback, because the credential rides it', () => {
    const problems = problemsFor([{ ...valid, endpoint: 'http://api.example.com/v1' }])
    expect(problems[0]?.code).toBe('insecure_binary_generator_endpoint')
    expect(problemsFor([{ ...valid, endpoint: 'http://localhost:8080' }])).toEqual([])
  })

  it('fails boot when a declared media type contradicts the declared content types', () => {
    // Both halves drive selection — coverage is checked against `modalities`, while the brief
    // tells the agent the `mediaTypes` — so this integration would be picked for one job and
    // asked to do the other.
    const problems = problemsFor([{ ...valid, modalities: ['audio'], mediaTypes: ['image/png'] }])
    expect(problems[0]?.code).toBe('binary_generator_modality_mismatch')
  })

  it('accepts a media type it cannot classify rather than refusing a format it has not heard of', () => {
    expect(problemsFor([{ ...valid, mediaTypes: ['application/x-newfangled'] }])).toEqual([])
  })

  it('accepts EITHER 3D content type against a container that could hold both', () => {
    // Contradiction is an empty INTERSECTION, not an absent member. A `.glb` is one asset or a
    // whole scene and the container does not record which, so requiring every consistent member
    // would refuse a scene generator for declaring the only format it can emit.
    for (const modalities of [['3d-model'], ['3d-scene'], ['3d-model', '3d-scene']] as const) {
      expect(
        problemsFor([{ ...valid, modalities: [...modalities], mediaTypes: ['model/gltf-binary'] }]),
      ).toEqual([])
    }
    // …and a genuine contradiction is still one.
    expect(
      problemsFor([{ ...valid, modalities: ['audio'], mediaTypes: ['model/gltf-binary'] }])[0]
        ?.code,
    ).toBe('binary_generator_modality_mismatch')
  })

  it('reports a malformed definition ONCE rather than restating it as several', () => {
    expect(
      problemsFor([{ ...valid, id: 'Retro Diffusion', endpoint: 'http://api.example.com' }]),
    ).toHaveLength(1)
  })

  it('requires at least one content type — a generator that produces nothing is not one', () => {
    expect(problemsFor([{ ...valid, modalities: [] }])).toHaveLength(1)
  })
})

describe('custom task types (reusable operations)', () => {
  const base = {
    presentation: {
      label: 'Introduce API',
      icon: 'i-lucide-plug',
      color: '#0ea5e9',
      description: 'Expose functionality over HTTP.',
    },
  }
  const problemsFor = (taskType: CustomTaskType) => {
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register(taskType)
    return collectRegistrationProblems({
      agentKindRegistry: defaultAgentKindRegistry(),
      gateRegistry: defaultGateRegistry(),
      taskTypeRegistry,
    })
  }

  afterEach(() => clearRegisteredPromptFragments())

  it('resolves defaultFragmentIds against the code pool without complaint', () => {
    registerPromptFragment({
      id: 'org.api-guidelines',
      version: '1.0.0',
      title: 'Org API guidelines',
      category: 'Org',
      summary: 'How this org shapes APIs.',
      body: 'Plural nouns.',
    })
    expect(
      problemsFor({
        ...base,
        taskType: 'org:introduce-api',
        defaultFragmentIds: ['org.api-guidelines'],
      }),
    ).toEqual([])
  })

  it('WARNS on an unresolvable fragment id, naming both causes it cannot tell apart', () => {
    // A workspace/account-tier fragment merges per workspace at RUN time, so boot structurally
    // cannot see one: refusing would reject a legitimate tenant-tier reference, and staying
    // silent leaves a typo'd id folding nothing for the life of the deployment.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      defaultFragmentIds: ['org.api-guidelnes'],
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.severity).toBe('warn')
    expect(problems[0]?.code).toBe('task_type_unknown_fragment')
    expect(problems[0]?.message).toContain('org.api-guidelnes')
    expect(problems[0]?.message).toContain('account/workspace-tier')
    // A warn never aborts boot; it is reported through `onWarn`.
    const warned: string[] = []
    const taskTypeRegistry = defaultTaskTypeRegistry()
    taskTypeRegistry.register({
      ...base,
      taskType: 'org:introduce-api',
      defaultFragmentIds: ['org.api-guidelnes'],
    })
    expect(() =>
      validateRegistrations({
        agentKindRegistry: defaultAgentKindRegistry(),
        gateRegistry: defaultGateRegistry(),
        taskTypeRegistry,
        onWarn: (p) => warned.push(p.code),
      }),
    ).not.toThrow()
    expect(warned).toContain('task_type_unknown_fragment')
  })

  it('still ERRORS on a defaultPipelineId that resolves to nothing', () => {
    // The pipeline reference is a different bar from the fragment one: an unknown id means the
    // created task silently falls back to the workspace's positional default pipeline, and
    // nothing at run time can tell that apart from a deliberate choice.
    const problems = problemsFor({
      ...base,
      taskType: 'org:introduce-api',
      defaultPipelineId: 'pl_nope',
    })
    expect(problems[0]?.severity).toBe('error')
    expect(problems[0]?.code).toBe('task_type_unknown_pipeline')
  })
})
