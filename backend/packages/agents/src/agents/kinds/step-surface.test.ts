import { afterEach, describe, expect, it } from 'vitest'
import { isInlineModelStep } from './step-surface.js'
import { clearRegisteredAgentKinds, registerAgentKind } from './registry.js'

describe('isInlineModelStep', () => {
  afterEach(() => clearRegisteredAgentKinds())

  it('is true for the built-in engine-inline kinds', () => {
    for (const kind of [
      'requirements-review',
      'clarity-review',
      'requirements-brainstorm',
      'architecture-brainstorm',
      'task-estimator',
    ]) {
      expect(isInlineModelStep(kind)).toBe(true)
    }
  })

  it('is false for container agent kinds and non-LLM gate/one-shot kinds', () => {
    for (const kind of ['coder', 'architect', 'merger', 'ci', 'conflicts', 'tracker', 'deployer']) {
      expect(isInlineModelStep(kind)).toBe(false)
    }
  })

  it('follows a registered custom kind by its declared surface', () => {
    registerAgentKind({ kind: 'org-inline', systemPrompt: 'x', agent: { surface: 'inline' } })
    registerAgentKind({
      kind: 'org-container',
      systemPrompt: 'x',
      agent: { surface: 'container-explore' },
    })
    expect(isInlineModelStep('org-inline')).toBe(true)
    expect(isInlineModelStep('org-container')).toBe(false)
  })
})
