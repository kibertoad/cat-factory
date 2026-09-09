import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { testingContextSection } from './standard.js'

function ctx(agentKind: string, testingContext?: string): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    service: { type: 'service', ...(testingContext ? { testingContext } : {}) },
  }
}

describe('testingContextSection', () => {
  it('is empty for every kind that is not a tester', () => {
    // The context rides `service`, which every dispatch resolves, so the KIND is what decides
    // who is told it. Byte-identical prompts for everything else is the point of this test.
    for (const kind of ['coder', 'reviewer', 'architect', 'ci-fixer', 'merger']) {
      expect(testingContextSection(ctx(kind, 'sign in as $DEMO_USER'))).toBe('')
    }
  })

  it('renders the prose verbatim for both tester surfaces', () => {
    const prose = 'Sign in as $DEMO_USER. Seeded tenant: Acme. The billing flow charges a card.'
    for (const kind of ['tester-api', 'tester-ui']) {
      const out = testingContextSection(ctx(kind, prose))
      expect(out).toContain('Testing context for this service:')
      expect(out).toContain(prose)
    }
  })

  it('states the absence to a tester rather than dropping the section', () => {
    const out = testingContextSection(ctx('tester-api'))
    expect(out).toContain('NONE RECORDED')
  })

  it('treats whitespace-only prose as nothing recorded', () => {
    // The engine trims before it resolves, but a caller that did not must not produce a section
    // claiming a human wrote something.
    expect(testingContextSection(ctx('tester-api', '   \n  '))).toContain('NONE RECORDED')
  })
})
