import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { ownServiceSection, renderStandardUserPrompt } from './standard.js'

function ctx(ownService?: AgentRunContext['ownService']): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'Full build',
    stepIndex: 1,
    isFinalStep: false,
    block: { title: 'implement webhooks', type: 'api', description: 'add webhooks' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...(ownService ? { ownService } : {}),
  }
}

// Every other section here is omitted when empty; this one REPORTS its absence, because a task
// title on its own ("implement webhooks") identifies no software and a silent omission reads exactly
// like a task whose product is obvious from context.
describe('ownServiceSection', () => {
  it('names the service the work belongs to, with its description', () => {
    const out = ownServiceSection(
      ctx({
        stated: true,
        frameId: 'blk_frame',
        title: 'billing-api',
        description: 'Invoicing and payment collection.',
      }),
    )
    expect(out).toContain('The system this work belongs to: billing-api')
    expect(out).toContain('Invoicing and payment collection.')
  })

  it('STATES that no owning system was resolved', () => {
    const out = ownServiceSection(ctx({ stated: false, reason: 'not-under-a-service' }))
    expect(out).toContain('NOT STATED')
    expect(out).toContain('do not infer a product')
  })

  it('says nothing when the block under work IS the service', () => {
    expect(ownServiceSection(ctx({ stated: false, reason: 'block-is-the-service' }))).toBe('')
  })

  it('makes no claim when the context never populated the field', () => {
    // A caller that did not resolve the field has not established an absence — asserting one would
    // put a false statement about the board into the prompt.
    expect(ownServiceSection(ctx())).toBe('')
  })

  it('reaches the standard-phase user prompt, not just the generic one', () => {
    const rendered = renderStandardUserPrompt('build', {
      ...ctx({ stated: true, frameId: 'blk_frame', title: 'billing-api' }),
    })
    expect(rendered).toContain('The system this work belongs to: billing-api')
  })
})
