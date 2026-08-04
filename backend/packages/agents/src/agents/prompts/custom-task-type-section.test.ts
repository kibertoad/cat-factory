import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { customTaskTypeSection, renderStandardUserPrompt } from './standard.js'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { userPromptFor } from '../catalog.js'

const PARAMS: AgentRunContext['customTaskType'] = {
  taskType: 'org:introduce-api',
  label: 'Introduce API',
  fields: [
    { key: 'entity', label: 'Entity', value: 'Order' },
    { key: 'authRequirement', label: 'Auth requirement', value: 'Service-to-service token' },
  ],
}

function ctx(overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'Introduce API',
    stepIndex: 1,
    isFinalStep: false,
    block: { title: 'Expose orders', type: 'api', description: 'Expose the order entity.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...overrides,
  }
}

describe('customTaskTypeSection', () => {
  it('renders the collected parameters under the type label', () => {
    const out = customTaskTypeSection(ctx({ customTaskType: PARAMS }))
    expect(out).toContain('## Task parameters (Introduce API)')
    expect(out).toContain('- Entity: Order')
    expect(out).toContain('- Auth requirement: Service-to-service token')
  })

  it('falls back to the raw key for a field the descriptor no longer labels', () => {
    const out = customTaskTypeSection(
      ctx({
        customTaskType: { ...PARAMS, fields: [{ key: 'legacyScope', value: 'read-only' }] },
      }),
    )
    expect(out).toContain('- legacyScope: read-only')
  })

  it('is empty on every run that collected no parameters', () => {
    expect(customTaskTypeSection(ctx())).toBe('')
    expect(customTaskTypeSection(ctx({ customTaskType: { ...PARAMS, fields: [] } }))).toBe('')
  })

  it('continues a multi-line value as an indented block under its label', () => {
    // A `textarea` field. Rendered inline, its second line leaves the bullet list and its last
    // runs into the closing guidance, reading as part of the platform's own instruction.
    const out = customTaskTypeSection(
      ctx({
        customTaskType: {
          ...PARAMS,
          fields: [{ key: 'notes', label: 'Notes', value: 'Due Friday.\nAsked for by billing.' }],
        },
      }),
    )
    expect(out).toContain('- Notes:\n  Due Friday.\n  Asked for by billing.')
    expect(out).not.toContain('- Notes: Due Friday.')
    // The closing guidance still reads as the platform's, separated from the requester's text.
    expect(out).toContain('\n\nThese are the values this task was created with.')
  })

  it('splits CRLF too, leaving no stray carriage return in the prompt', () => {
    const out = customTaskTypeSection(
      ctx({
        customTaskType: {
          ...PARAMS,
          fields: [{ key: 'notes', label: 'Notes', value: 'One.\r\nTwo.' }],
        },
      }),
    )
    expect(out).toContain('- Notes:\n  One.\n  Two.')
    expect(out).not.toContain('\r')
  })

  // The regression bar for anything touching this fold: a run with no custom fields must render
  // exactly what it rendered before the fold existed, on every emit point.
  it('leaves a prompt without parameters byte-identical', () => {
    const registry = defaultAgentKindRegistry()
    const base = ctx()
    expect(renderStandardUserPrompt('build', base)).toBe(
      renderStandardUserPrompt('build', { ...base, customTaskType: undefined }),
    )
    expect(userPromptFor(base, registry)).toBe(
      userPromptFor({ ...base, customTaskType: undefined }, registry),
    )
  })

  describe('the three emit points', () => {
    it('reaches a STANDARD phase prompt, after the block context it qualifies', () => {
      const rendered = renderStandardUserPrompt('build', ctx({ customTaskType: PARAMS }))
      expect(rendered).toContain('## Task parameters (Introduce API)')
      // The requester's own words stay above the derived brief.
      expect(rendered.indexOf('Expose the order entity.')).toBeLessThan(
        rendered.indexOf('## Task parameters'),
      )
    })

    it('reaches the GENERIC prompt of a registered kind that authors none', () => {
      const registry = defaultAgentKindRegistry()
      registry.register({
        kind: 'org-doc-lint',
        systemPrompt: 'lint',
        agent: { surface: 'inline' },
      })
      const rendered = userPromptFor(
        ctx({ agentKind: 'org-doc-lint', customTaskType: PARAMS }),
        registry,
      )
      expect(rendered).toContain('## Task parameters (Introduce API)')
    })

    it('reaches a registered kind that authors its OWN user prompt', () => {
      // The emit point that matters most: an org's reusable operation typically runs on that
      // org's own kinds, and those are exactly the kinds that build their own prompt.
      const registry = defaultAgentKindRegistry()
      registry.register({
        kind: 'org-api-designer',
        systemPrompt: 'design',
        agent: { surface: 'inline' },
        userPrompt: () => 'Design the API.',
      })
      const rendered = userPromptFor(
        ctx({ agentKind: 'org-api-designer', customTaskType: PARAMS }),
        registry,
      )
      expect(rendered).toContain('## Task parameters (Introduce API)')
      expect(rendered).toContain('Design the API.')
      expect(rendered.indexOf('## Task parameters')).toBeLessThan(
        rendered.indexOf('Design the API.'),
      )
    })
  })
})
