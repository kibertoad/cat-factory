import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import {
  BLUEPRINTS_AGENT_KIND,
  blueprintUserPrompt,
  SPEC_WRITER_AGENT_KIND,
  specWriterUserPrompt,
} from './spec-blueprints.js'
import { defaultAgentKindRegistry } from './registry.js'
import { systemPromptFor } from '../catalog.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'
import { READ_ONLY_GUARDRAIL } from './read-only.js'

const context = (block: Record<string, unknown>): AgentRunContext =>
  ({
    agentKind: SPEC_WRITER_AGENT_KIND,
    pipelineName: 'Ship',
    block,
    decisions: [],
    priorOutputs: [],
  }) as unknown as AgentRunContext

describe('blueprintUserPrompt', () => {
  it('instructs an update-or-create that returns the complete tree as JSON only', () => {
    const p = blueprintUserPrompt()
    expect(p).toContain('canonical service → modules blueprint')
    expect(p).toContain('blueprints/blueprint.json')
    expect(p).toContain('ONLY the JSON object')
  })
})

describe('specWriterUserPrompt', () => {
  it('embeds the block header + description and the default self-determine guidance', () => {
    const p = specWriterUserPrompt(
      context({ id: 'b9', title: 'Refactor auth', type: 'task', description: 'Tidy it' }),
    )
    expect(p).toContain('### Refactor auth (block b9)')
    expect(p).toContain('Tidy it')
    expect(p).toContain('If this task is purely TECHNICAL')
  })

  it('withdraws the no-specs escape hatch for an explicit BUSINESS task', () => {
    const p = specWriterUserPrompt(
      context({ id: 'b1', title: 'T', type: 'task', technical: false }),
    )
    expect(p).toContain('explicitly flagged BUSINESS')
    expect(p).not.toContain('If this task is purely TECHNICAL')
  })

  it('tells an explicit TECHNICAL task the empty outcome is expected', () => {
    const p = specWriterUserPrompt(context({ id: 'b1', title: 'T', type: 'task', technical: true }))
    expect(p).toContain('explicitly flagged TECHNICAL')
    expect(p).toContain('{"noBusinessSpecs": true}')
  })
})

describe('registered blueprints + spec-writer kinds', () => {
  const registry = defaultAgentKindRegistry()

  it('registers both as read-only structured container-explore kinds with no presentation', () => {
    // Blueprinter: clones the PR branch, returns the tree as JSON only.
    expect(registry.requiresContainer(BLUEPRINTS_AGENT_KIND)).toBe(true)
    expect(registry.agentStep(BLUEPRINTS_AGENT_KIND)?.surface).toBe('container-explore')
    expect(registry.agentStep(BLUEPRINTS_AGENT_KIND)?.clone?.branch).toBe('pr')
    expect(registry.agentStep(BLUEPRINTS_AGENT_KIND)?.output?.kind).toBe('structured')
    // Spec-writer: clones the work branch; its doc is handed onward, so a truncated final
    // answer must fail loudly rather than be laundered by the structured repair.
    expect(registry.agentStep(SPEC_WRITER_AGENT_KIND)?.clone?.branch).toBe('work')
    expect(registry.agentStep(SPEC_WRITER_AGENT_KIND)?.output?.failOnUnusableFinal).toBe(true)
    // Pipeline-internal, not user-draggable palette kinds: they stay out of `customAgentKinds`.
    expect(registry.presentation(BLUEPRINTS_AGENT_KIND)).toBeUndefined()
    expect(registry.presentation(SPEC_WRITER_AGENT_KIND)).toBeUndefined()
  })

  it('applies the surface directives centrally (read-only guardrail + final-answer-in-reply)', () => {
    // The constants no longer restate the final-answer directive; `systemPromptFor` appends
    // it (and the read-only guardrail) exactly once for a registered container-explore kind.
    for (const kind of [BLUEPRINTS_AGENT_KIND, SPEC_WRITER_AGENT_KIND]) {
      const prompt = systemPromptFor(kind, registry)
      expect(prompt).toContain(READ_ONLY_GUARDRAIL)
      expect(prompt).toContain(FINAL_ANSWER_IN_REPLY)
      expect(prompt.split(FINAL_ANSWER_IN_REPLY)).toHaveLength(2)
    }
  })
})
