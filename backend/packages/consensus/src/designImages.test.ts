import type { AgentRunContext } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, userPromptFor } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { panelDesignImageCeiling } from './designImages.js'

const registry = defaultAgentKindRegistry()

const FILES = [
  { view: 'Checkout', artifactId: 'art_1', contentType: 'image/png', fileName: 'Checkout.png' },
]

function context(over: Partial<AgentRunContext>): AgentRunContext {
  return {
    agentKind: 'architect',
    pipelineName: 'design',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'Build the checkout screen', type: 'service', description: 'Do the thing' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as unknown as AgentRunContext
}

describe('panelDesignImageCeiling', () => {
  it('says nothing for a task that links no design', () => {
    // Most steps. The panel prompt must stay byte-for-byte what it was for them.
    expect(panelDesignImageCeiling(context({}))).toEqual({})
  })

  it('states the withholding, so the goal prompt cannot go out silent about it', () => {
    // `architect` carries the design-images trait AND is consensus-eligible by default, so this is
    // the commonest panel on a task with a design. Without a verdict the section renders EMPTY,
    // which reads to the agent exactly like a task that links no design at all.
    const withSet = context({ designImages: { files: FILES, omitted: [] } })
    expect(userPromptFor(withSet, registry)).not.toContain('Design pictures')

    const prompt = userPromptFor({ ...withSet, ...panelDesignImageCeiling(withSet) }, registry)
    expect(prompt).toContain('multi-model panel')
    // The views still reach the participants: a named screen they cannot see is actionable, and an
    // omitted one leaves the textual description reading as everything the platform had.
    expect(prompt).toContain('Checkout')
    // No channel is promised, in either direction.
    expect(prompt).not.toContain('attached to this message')
    expect(prompt).not.toContain('.cat-context/design-renders')
  })
})
