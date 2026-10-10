import { describe, expect, it } from 'vitest'
import { INITIATIVE_ANALYST_AGENT_KIND, INITIATIVE_PLANNER_AGENT_KIND } from '@cat-factory/kernel'
import { AgentKindRegistry, defaultAgentKindRegistry } from './registry.js'
import { PR_REVIEWER_KIND } from './pr-reviewer.js'

// The agent-definition extension fields added on top of the kind registry:
// presentation (frontend metadata), the agent-step surface, and the pre/post-op hooks.
// Each test news a fresh, app-owned registry (no module-global to clear).

describe('agent-definition registry fields', () => {
  it('derives the container requirement from a container agent surface', () => {
    const registry = new AgentKindRegistry()
    registry.register({ kind: 'org-inline', systemPrompt: 'x', agent: { surface: 'inline' } })
    registry.register({
      kind: 'org-explore',
      systemPrompt: 'x',
      agent: { surface: 'container-explore', output: { kind: 'structured' } },
    })
    registry.register({
      kind: 'org-coding',
      systemPrompt: 'x',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    expect(registry.requiresContainer('org-inline')).toBe(false)
    expect(registry.requiresContainer('org-explore')).toBe(true)
    expect(registry.requiresContainer('org-coding')).toBe(true)
  })

  it('still honours an explicit requiresContainer flag', () => {
    const registry = new AgentKindRegistry()
    registry.register({ kind: 'org-repo', systemPrompt: 'x', requiresContainer: true })
    expect(registry.requiresContainer('org-repo')).toBe(true)
  })

  it('exposes the agent step spec, presentation, and pre/post-op hooks', () => {
    const registry = new AgentKindRegistry()
    const preOp = async () => {}
    const postOp = async () => {}
    registry.register({
      kind: 'security-auditor',
      systemPrompt: 'You audit.',
      agent: { surface: 'container-explore', output: { kind: 'structured', repair: true } },
      preOps: [preOp],
      postOps: [postOp],
      presentation: {
        label: 'Security Auditor',
        icon: 'i-lucide-shield',
        color: '#ef4444',
        description: 'Audits the codebase.',
        category: 'review',
        resultView: 'generic-structured',
      },
    })
    expect(registry.agentStep('security-auditor')).toEqual({
      surface: 'container-explore',
      output: { kind: 'structured', repair: true },
    })
    expect(registry.preOps('security-auditor')).toEqual([preOp])
    expect(registry.postOps('security-auditor')).toEqual([postOp])
    expect(registry.presentation('security-auditor')?.label).toBe('Security Auditor')
    expect(registry.presentation('security-auditor')?.resultView).toBe('generic-structured')
  })

  it('registers the built-in pr-reviewer as a read-only structured review kind', () => {
    const registry = defaultAgentKindRegistry()
    // A container-explore kind ⇒ requires a container, read-only (no PR opened).
    expect(registry.requiresContainer(PR_REVIEWER_KIND)).toBe(true)
    expect(registry.agentStep(PR_REVIEWER_KIND)?.surface).toBe('container-explore')
    // Structured output is derived from the schema (a shapeHint is present).
    expect(registry.agentStep(PR_REVIEWER_KIND)?.output?.kind).toBe('structured')
    expect(registry.structuredOutput(PR_REVIEWER_KIND)).toBeDefined()
    // First-class palette + the dedicated PR-review result view (findings + multi-select).
    const presentation = registry.presentation(PR_REVIEWER_KIND)
    expect(presentation?.category).toBe('review')
    expect(presentation?.resultView).toBe('pr-review')
  })

  it('registers the built-in initiative planning kinds as read-only container-explore kinds', () => {
    const registry = defaultAgentKindRegistry()
    // Both explore a read-only checkout on the base branch, so they must require a container —
    // the fact CompositeAgentExecutor's `pick()` now relies on instead of a hard-coded list.
    for (const kind of [INITIATIVE_ANALYST_AGENT_KIND, INITIATIVE_PLANNER_AGENT_KIND]) {
      expect(registry.requiresContainer(kind)).toBe(true)
      expect(registry.agentStep(kind)?.surface).toBe('container-explore')
      expect(registry.agentStep(kind)?.clone?.branch).toBe('base')
    }
    // The analyst returns prose (no structured output); the planner returns the plan as JSON.
    expect(registry.agentStep(INITIATIVE_ANALYST_AGENT_KIND)?.output).toBeUndefined()
    expect(registry.agentStep(INITIATIVE_PLANNER_AGENT_KIND)?.output?.kind).toBe('structured')
    // Pipeline-internal steps, not user-draggable palette kinds ⇒ no presentation.
    expect(registry.presentation(INITIATIVE_ANALYST_AGENT_KIND)).toBeUndefined()
    expect(registry.presentation(INITIATIVE_PLANNER_AGENT_KIND)).toBeUndefined()
  })

  it('returns empty / undefined for kinds that did not opt in', () => {
    const registry = new AgentKindRegistry()
    registry.register({ kind: 'bare', systemPrompt: 'x' })
    expect(registry.agentStep('bare')).toBeUndefined()
    expect(registry.preOps('bare')).toEqual([])
    expect(registry.postOps('bare')).toEqual([])
    expect(registry.presentation('bare')).toBeUndefined()
    expect(registry.presentation('never-registered')).toBeUndefined()
  })
})
