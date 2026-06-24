import type { AgentRunContext } from '@cat-factory/kernel'
import type { clarityLogic, requirementsLogic } from '@cat-factory/orchestration'
import { describe, expect, it } from 'vitest'
import { builtinFixture, builtinFixturesFor } from './registry.js'

// Compile-time conformance: a fixture's `payload` is `Record<string, unknown>` on the wire,
// but it MUST be the exact context shape the agent actually consumes. These typed literals
// are checked against the real context types from orchestration/kernel (dev-only imports,
// erased at runtime), and `toEqual` ties each one to the committed fixture so a drift in the
// fixture payload — or in the upstream context type — fails this test instead of shipping.
// (This lives in a test so the library build never depends on orchestration/kernel.)

describe('fixture payloads conform to the agents’ context types', () => {
  it('requirements-review payload is a RequirementsContext', () => {
    const expected: requirementsLogic.RequirementsContext = {
      block: {
        title: 'Notification preferences',
        type: 'service',
        description:
          'Let users turn off notifications they do not want. Add a settings page where they can toggle notifications on or off.',
      },
      docs: [],
      tasks: [],
    }
    expect(builtinFixture('req-notify-prefs-simple')?.payload).toEqual(expected)
  })

  it('clarity-review payload is a ClarityContext', () => {
    const expected: clarityLogic.ClarityContext = {
      block: {
        title: 'Dashboard is slow',
        type: 'service',
        description: 'The dashboard is really slow now. Please fix it, it was fine before.',
      },
    }
    expect(builtinFixture('clarity-slow-page-simple')?.payload).toEqual(expected)
  })

  it('reviewer payloads are reviewer AgentRunContexts carrying the work in priorOutputs', () => {
    for (const f of builtinFixturesFor('reviewer')) {
      // The cast is checked by the structural assertions below; the type import proves the
      // shape exists. Each must be a final-step reviewer context with a coder prior output.
      const ctx = f.payload as unknown as AgentRunContext
      expect(ctx.agentKind).toBe('reviewer')
      expect(ctx.isFinalStep).toBe(true)
      expect(
        ctx.priorOutputs.some((p) => p.agentKind === 'coder' && p.output.includes('```')),
      ).toBe(true)
      expect(ctx.resolvedDecision).toBeNull()
    }
  })

  it('architecture payloads are architect-companion contexts reviewing an architect proposal', () => {
    for (const f of builtinFixturesFor('architect-companion')) {
      const ctx = f.payload as unknown as AgentRunContext
      expect(ctx.agentKind).toBe('architect-companion')
      expect(ctx.priorOutputs.some((p) => p.agentKind === 'architect')).toBe(true)
    }
  })

  it('every requirements/clarity block uses a valid BlockType', () => {
    const valid = new Set([
      'frontend',
      'service',
      'api',
      'database',
      'queue',
      'integration',
      'external',
      'environment',
    ])
    for (const kind of ['requirements-review', 'clarity-review']) {
      for (const f of builtinFixturesFor(kind)) {
        const block = (f.payload as { block: { type: string } }).block
        expect(valid.has(block.type)).toBe(true)
      }
    }
  })
})
