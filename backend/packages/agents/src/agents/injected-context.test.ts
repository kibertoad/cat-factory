import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { userPromptFor } from './catalog.js'
import { defaultAgentKindRegistry } from './kinds/registry.js'
import { STANDARDS_CONTEXT_INDEX_FILE } from './runtime/fragments.js'

// The fold that makes a preOp's prepared context reach a caller with no filesystem — the inline
// executor and, above all, a consensus PANEL, whose participants are plain model calls. The
// container path materialises the same bodies into `.cat-context/` instead, so it must never also
// receive them here.

const registry = defaultAgentKindRegistry()

function ctx(files: { path: string; content: string }[]): AgentRunContext {
  return {
    agentKind: 'reviewer',
    pipelineName: 'Review',
    stepIndex: 0,
    isFinalStep: false,
    block: { title: 'Billing', type: 'task', description: 'Check the change.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    injectedContextFiles: files,
  } as unknown as AgentRunContext
}

describe('injected context files in the user prompt', () => {
  it('folds a prepared file in for an inline caller', () => {
    const out = userPromptFor(ctx([{ path: 'pr-diff.md', content: 'THE DIFF BODY' }]), registry)
    expect(out).toContain('pr-diff.md')
    expect(out).toContain('THE DIFF BODY')
  })

  it('folds nothing for the CONTAINER caller, which reads the same bodies off disk', () => {
    const out = userPromptFor(ctx([{ path: 'pr-diff.md', content: 'THE DIFF BODY' }]), registry, {
      materialized: true,
    })
    expect(out).not.toContain('THE DIFF BODY')
  })

  it('leaves STANDARDS files out — they reach the model through the system prompt', () => {
    // Folding them here too would both duplicate every standard and restore its FULL body,
    // bypassing the `brief` verbosity an implementer kind is meant to get.
    const out = userPromptFor(
      ctx([
        { path: STANDARDS_CONTEXT_INDEX_FILE, content: 'STANDARDS INDEX BODY' },
        { path: 'standard-idiomatic-ts.md', content: 'STANDARD BODY' },
        { path: 'pr-diff.md', content: 'THE DIFF BODY' },
      ]),
      registry,
    )
    expect(out).toContain('THE DIFF BODY')
    expect(out).not.toContain('STANDARDS INDEX BODY')
    expect(out).not.toContain('STANDARD BODY')
  })

  it('is bounded, and NAMES what it dropped rather than shortening in silence', () => {
    const huge = 'x'.repeat(400_000)
    const out = userPromptFor(
      ctx([
        { path: 'pr-diff.md', content: 'SMALL BODY' },
        { path: 'giant.md', content: huge },
      ]),
      registry,
    )
    expect(out).toContain('SMALL BODY')
    expect(out).not.toContain(huge)
    expect(out).toContain('NOT INCLUDED')
    expect(out).toContain('giant.md')
  })
})
