import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredAgentKinds,
  registerAgentKind,
  registeredAgentPresentation,
  registeredAgentStep,
  registeredKindRequiresContainer,
  registeredPostOps,
  registeredPreOps,
} from './registry.js'

// The agent-definition extension fields added on top of the kind registry:
// presentation (frontend metadata), the agent-step surface, and the pre/post-op hooks.

describe('agent-definition registry fields', () => {
  afterEach(() => clearRegisteredAgentKinds())

  it('derives the container requirement from a container agent surface', () => {
    registerAgentKind({ kind: 'org-inline', systemPrompt: 'x', agent: { surface: 'inline' } })
    registerAgentKind({
      kind: 'org-explore',
      systemPrompt: 'x',
      agent: { surface: 'container-explore', output: { kind: 'structured' } },
    })
    registerAgentKind({
      kind: 'org-coding',
      systemPrompt: 'x',
      agent: { surface: 'container-coding', clone: { branch: 'pr' } },
    })
    expect(registeredKindRequiresContainer('org-inline')).toBe(false)
    expect(registeredKindRequiresContainer('org-explore')).toBe(true)
    expect(registeredKindRequiresContainer('org-coding')).toBe(true)
  })

  it('still honours an explicit requiresContainer flag', () => {
    registerAgentKind({ kind: 'org-repo', systemPrompt: 'x', requiresContainer: true })
    expect(registeredKindRequiresContainer('org-repo')).toBe(true)
  })

  it('exposes the agent step spec, presentation, and pre/post-op hooks', () => {
    const preOp = async () => {}
    const postOp = async () => {}
    registerAgentKind({
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
    expect(registeredAgentStep('security-auditor')).toEqual({
      surface: 'container-explore',
      output: { kind: 'structured', repair: true },
    })
    expect(registeredPreOps('security-auditor')).toEqual([preOp])
    expect(registeredPostOps('security-auditor')).toEqual([postOp])
    expect(registeredAgentPresentation('security-auditor')?.label).toBe('Security Auditor')
    expect(registeredAgentPresentation('security-auditor')?.resultView).toBe('generic-structured')
  })

  it('returns empty / undefined for kinds that did not opt in', () => {
    registerAgentKind({ kind: 'bare', systemPrompt: 'x' })
    expect(registeredAgentStep('bare')).toBeUndefined()
    expect(registeredPreOps('bare')).toEqual([])
    expect(registeredPostOps('bare')).toEqual([])
    expect(registeredAgentPresentation('bare')).toBeUndefined()
    expect(registeredAgentPresentation('never-registered')).toBeUndefined()
  })
})
