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
    ownService: { stated: true, frameId: 'frame_grass', title: 'Grass API' },
    service: { type: 'service', ...(testingContext ? { testingContext } : {}) },
  }
}

/** A tester run on work that sits under no service frame at all: the walk resolved nothing. */
function looseCtx(): AgentRunContext {
  return {
    ...ctx('tester-api'),
    ownService: { stated: false, reason: 'not-under-a-service' },
    service: undefined,
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

  it('does not blame a service for a blank field when no service owns the work', () => {
    // The two absences are opposite facts. "Nobody filled this in" against work the platform
    // never placed under a service is a finding filed at whoever owns a service that was never
    // resolved, which is the misattribution the section exists to prevent, not commit.
    const out = testingContextSection(looseCtx())
    expect(out).toContain('NO SERVICE ON THE BOARD OWNS THIS WORK')
    expect(out).not.toContain('NONE RECORDED')
    // The heading claims a service too, so it moves with the body.
    expect(out).not.toContain('for this service')
  })
})
