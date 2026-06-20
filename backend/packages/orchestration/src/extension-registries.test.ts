import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredAgentKinds,
  registerAgentKind,
  registeredKindRequiresContainer,
  systemPromptFor,
  userPromptFor,
} from '@cat-factory/agents'
import type { AgentRunContext } from '@cat-factory/kernel'
import { clearRegisteredPipelines, registerPipeline, seedPipelines } from '@cat-factory/kernel'

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

  it('seeds built-in pipelines on their own', () => {
    const ids = seedPipelines().map((p) => p.id)
    expect(ids).toEqual([
      'pl_full',
      'pl_quick',
      'pl_integrate',
      'pl_dep_update',
      'pl_tech_debt',
      'pl_blueprint',
    ])
  })

  it('appends a registered pipeline after the built-ins', () => {
    registerPipeline({ id: 'pl_org_audit', name: 'Audit & ship', agentKinds: ['org-auditor'] })
    const pipelines = seedPipelines()
    expect(pipelines.map((p) => p.id)).toEqual([
      'pl_full',
      'pl_quick',
      'pl_integrate',
      'pl_dep_update',
      'pl_tech_debt',
      'pl_blueprint',
      'pl_org_audit',
    ])
    expect(pipelines.at(-1)).toEqual({
      id: 'pl_org_audit',
      name: 'Audit & ship',
      agentKinds: ['org-auditor'],
    })
  })

  it('replaces a built-in pipeline in place when ids collide', () => {
    registerPipeline({ id: 'pl_quick', name: 'Org quick', agentKinds: ['coder', 'merger'] })
    const pipelines = seedPipelines()
    expect(pipelines.map((p) => p.id)).toEqual([
      'pl_full',
      'pl_quick',
      'pl_integrate',
      'pl_dep_update',
      'pl_tech_debt',
      'pl_blueprint',
    ])
    expect(pipelines.find((p) => p.id === 'pl_quick')?.name).toBe('Org quick')
  })
})
