import { describe, expect, it } from 'vitest'
import { isInlineModelStep } from './step-surface.js'
import { AgentKindRegistry } from './registry.js'

describe('isInlineModelStep', () => {
  it('is true for the built-in engine-inline kinds', () => {
    const registry = new AgentKindRegistry()
    for (const kind of [
      'requirements-review',
      'clarity-review',
      'requirements-brainstorm',
      'architecture-brainstorm',
      'task-estimator',
    ]) {
      expect(isInlineModelStep(kind, registry)).toBe(true)
    }
  })

  it('is false for container agent kinds and non-LLM gate/one-shot kinds', () => {
    const registry = new AgentKindRegistry()
    for (const kind of ['coder', 'architect', 'merger', 'ci', 'conflicts', 'tracker', 'deployer']) {
      expect(isInlineModelStep(kind, registry)).toBe(false)
    }
  })

  it('follows a registered custom kind by its declared surface', () => {
    const registry = new AgentKindRegistry()
    registry.register({ kind: 'org-inline', systemPrompt: 'x', agent: { surface: 'inline' } })
    registry.register({
      kind: 'org-container',
      systemPrompt: 'x',
      agent: { surface: 'container-explore' },
    })
    expect(isInlineModelStep('org-inline', registry)).toBe(true)
    expect(isInlineModelStep('org-container', registry)).toBe(false)
  })
})
