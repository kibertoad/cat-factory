import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import { baseSystemPromptFor, defaultAgentKindRegistry, systemPromptFor } from '@cat-factory/agents'
import {
  BESPOKE_CONTAINER_SYSTEM_PROMPTS,
  builtInBaseSystemPrompt,
  dispatchSystemPromptFor,
} from '../src/agents/promptOverrides.js'

// The container-dispatch half of the per-workspace prompt override. Two properties matter and
// neither is obvious from the call sites: an override must not be able to delete the directives
// the ENGINE enforces, and the prompt the editor calls "the built-in" must be the prompt the
// container actually runs — including for the two kinds whose dispatch bypasses
// `systemPromptFor` and sends a bespoke constant.

const registry = defaultAgentKindRegistry()

function context(agentKind: string, systemPromptOverride?: string): AgentRunContext {
  return {
    agentKind,
    pipelineName: 'p',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'b', title: 't', description: '' },
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
  } as unknown as AgentRunContext
}

describe('dispatchSystemPromptFor', () => {
  it('sends the shipped prompt when the workspace has no override', () => {
    expect(dispatchSystemPromptFor(context('coder'), registry)).toBe(
      systemPromptFor('coder', registry),
    )
  })

  it('replaces the track prompt with the override', () => {
    const prompt = dispatchSystemPromptFor(context('coder', 'Only touch one file.'), registry)
    expect(prompt).toContain('Only touch one file.')
    expect(prompt).not.toContain(baseSystemPromptFor('coder', registry))
  })

  it('still applies the engine-enforced directives on top of an override', () => {
    // The read-only guardrail (and the answer-in-your-reply rule) are how the platform runs a
    // kind, not editorial content. An override that could drop them would let a workspace turn a
    // read-only investigator into one that commits — a run-breaking edit made by accident.
    const shipped = systemPromptFor('architect', registry)
    const directives = shipped.slice(baseSystemPromptFor('architect', registry).length)
    expect(directives.trim()).not.toBe('')
    expect(dispatchSystemPromptFor(context('architect', 'Think hard.'), registry)).toBe(
      `Think hard.${directives}`,
    )
  })

  it('overrides a bespoke container kind, sending the override with nothing appended', () => {
    // The merger's dispatch never went through `systemPromptFor`, so appending directives here
    // would change what that kind sends — the override stands alone, exactly as its constant did.
    expect(dispatchSystemPromptFor(context('merger', 'Score generously.'), registry)).toBe(
      'Score generously.',
    )
  })

  it('sends the bespoke constant, not the thin role prompt, when a bespoke kind is unedited', () => {
    for (const [kind, prompt] of Object.entries(BESPOKE_CONTAINER_SYSTEM_PROMPTS)) {
      expect(dispatchSystemPromptFor(context(kind), registry)).toBe(prompt)
    }
  })
})

describe('builtInBaseSystemPrompt', () => {
  it('is the text the dispatch runs for an unedited kind, so a restore restores what ran', () => {
    // This is the invariant the editor's "built-in" baseline rests on. It holds trivially for a
    // normal kind and is the whole reason the bespoke map exists for the other two.
    for (const kind of ['coder', 'architect', ...Object.keys(BESPOKE_CONTAINER_SYSTEM_PROMPTS)]) {
      const builtIn = builtInBaseSystemPrompt(kind, registry)
      expect(dispatchSystemPromptFor(context(kind, builtIn), registry)).toBe(
        dispatchSystemPromptFor(context(kind), registry),
      )
    }
  })
})
