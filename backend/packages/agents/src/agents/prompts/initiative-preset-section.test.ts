import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { userPromptFor } from '../catalog.js'
import { initiativePresetSection } from './standard.js'

// Slice 1 (D1): the shared preset-steering section carries an initiative preset's standing per-kind
// methodology into a SPAWNED run's prompt — a standard-phase kind (coder, via `renderStandardUserPrompt`)
// AND a generic custom kind (via `buildBaseUserPrompt`). Absent ⇒ byte-identical prompt.

const registry = defaultAgentKindRegistry()

function ctx(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'coder',
    pipelineName: 'Build',
    stepIndex: 0,
    isFinalStep: false,
    block: { id: 'b1', title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as unknown as AgentRunContext
}

describe('initiativePresetSection', () => {
  it('is empty when the run carries no initiative preset', () => {
    expect(initiativePresetSection(ctx())).toBe('')
    expect(initiativePresetSection(ctx({ initiative: {} }))).toBe('')
    // A preset with a label but no addition (e.g. only a phaseTemplate) renders nothing here.
    expect(
      initiativePresetSection(ctx({ initiative: { preset: { label: 'Connector factory' } } })),
    ).toBe('')
  })

  it('renders the labelled section with the resolved per-kind promptAddition', () => {
    const out = initiativePresetSection(
      ctx({
        initiative: {
          preset: { label: 'Connector factory', promptAddition: 'Follow the org connector layout.' },
        },
      }),
    )
    expect(out).toContain('## Initiative preset: Connector factory')
    expect(out).toContain('Follow the org connector layout.')
  })

  it('never renders the planner-only phaseTemplate', () => {
    const out = initiativePresetSection(
      ctx({
        initiative: {
          preset: {
            label: 'Connector factory',
            promptAddition: 'Steer.',
            phaseTemplate: {
              phases: [{ id: 'research', title: 'Research', goal: 'Investigate.' }],
              allowAdditionalPhases: false,
            },
          },
        },
      }),
    )
    expect(out).toContain('## Initiative preset: Connector factory')
    expect(out).not.toContain('research')
    expect(out).not.toContain('Required plan shape')
  })
})

describe('preset steering reaches spawned-run prompts', () => {
  const preset = { label: 'Connector factory', promptAddition: 'Consume the build-handoff artifact.' }

  it('folds into a standard-phase (coder) user prompt', () => {
    const withPreset = userPromptFor(ctx({ initiative: { preset } }), registry, { materialized: true })
    const without = userPromptFor(ctx(), registry, { materialized: true })
    expect(withPreset).toContain('## Initiative preset: Connector factory')
    expect(withPreset).toContain('Consume the build-handoff artifact.')
    expect(without).not.toContain('## Initiative preset')
  })

  it('folds into a generic custom-kind user prompt', () => {
    const custom = (over: Partial<AgentRunContext>) =>
      userPromptFor(ctx({ agentKind: 'acme-biz-analyst', ...over }), registry, { materialized: true })
    const withPreset = custom({ initiative: { preset } })
    const without = custom({})
    expect(withPreset).toContain('## Initiative preset: Connector factory')
    expect(withPreset).toContain('Consume the build-handoff artifact.')
    expect(without).not.toContain('## Initiative preset')
  })
})
