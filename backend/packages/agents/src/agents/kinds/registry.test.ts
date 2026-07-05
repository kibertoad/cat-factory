import { describe, expect, it } from 'vitest'
import { AgentKindRegistry } from './registry.js'

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
