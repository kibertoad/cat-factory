import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import type { InitiativePresetPhaseTemplate } from '@cat-factory/contracts'
import { initiativeAnalystUserPrompt, initiativePlannerUserPrompt } from '../src/agents/prompts.js'

// The generic planner prompt fold (slice T1): a preset's declarative phase template renders a
// "Required plan shape" section into the PLANNER prompt only, verbatim phase ids in order. No
// template (the generic preset) ⇒ the free-form prompt is byte-for-byte unchanged.

const TEMPLATE: InitiativePresetPhaseTemplate = {
  phases: [
    {
      id: 'migration-blast-zone',
      title: 'Blast zone',
      goal: 'Enumerate touchpoints.',
      required: true,
    },
    { id: 'migration-coverage', title: 'Coverage hardening', goal: '', required: true },
    { id: 'migration-delivery', title: 'Delivery', goal: 'Execute the swap.' },
  ],
  allowAdditionalPhases: false,
}

function context(over: NonNullable<AgentRunContext['initiative']> = {}): AgentRunContext {
  return {
    agentKind: 'initiative-planner',
    block: {
      id: 'init_1',
      title: 'MSSQL → PostgreSQL',
      type: 'service',
      description: 'Swap the DB.',
    },
    initiative: over,
  } as unknown as AgentRunContext
}

describe('initiative planner prompt fold — phaseTemplate', () => {
  it('renders the required plan shape with verbatim phase ids in order', () => {
    const prompt = initiativePlannerUserPrompt(
      context({ preset: { label: 'Technological migration', phaseTemplate: TEMPLATE } }),
    )
    expect(prompt).toContain('## Required plan shape')
    expect(prompt).toContain('1. `migration-blast-zone` — Blast zone')
    expect(prompt).toContain('2. `migration-coverage` — Coverage hardening')
    // Order is preserved and ids are verbatim.
    expect(prompt.indexOf('migration-blast-zone')).toBeLessThan(
      prompt.indexOf('migration-coverage'),
    )
    expect(prompt.indexOf('migration-coverage')).toBeLessThan(prompt.indexOf('migration-delivery'))
    // A phase's goal is rendered when present; empty goals add no line.
    expect(prompt).toContain('Enumerate touchpoints.')
  })

  it('marks non-required phases optional and honours allowAdditionalPhases', () => {
    const exhaustive = initiativePlannerUserPrompt(
      context({ preset: { label: 'X', phaseTemplate: TEMPLATE } }),
    )
    // `migration-delivery` has no `required: true`, so it is annotated optional.
    expect(exhaustive).toContain('`migration-delivery` — Delivery (optional)')
    expect(exhaustive).toContain('Do NOT add, drop, rename, reorder or merge phases')

    const open = initiativePlannerUserPrompt(
      context({
        preset: { label: 'X', phaseTemplate: { ...TEMPLATE, allowAdditionalPhases: true } },
      }),
    )
    expect(open).toContain('You MAY append further phases')
    expect(open).not.toContain('Do NOT add, drop, rename')
  })

  it('renders the promptAddition heading independently of the template', () => {
    const prompt = initiativePlannerUserPrompt(
      context({ preset: { label: 'Technological migration', promptAddition: 'Be careful.' } }),
    )
    expect(prompt).toContain('## Initiative preset: Technological migration')
    expect(prompt).toContain('Be careful.')
    expect(prompt).not.toContain('## Required plan shape')
  })

  it('keeps the free-form planner prompt byte-for-byte when no preset is present', () => {
    const withPreset = initiativePlannerUserPrompt(
      context({ preset: { label: 'X', phaseTemplate: TEMPLATE } }),
    )
    const plain = initiativePlannerUserPrompt(context({}))
    const noInitiative = initiativePlannerUserPrompt({
      agentKind: 'initiative-planner',
      block: {
        id: 'init_1',
        title: 'MSSQL → PostgreSQL',
        type: 'service',
        description: 'Swap the DB.',
      },
    } as unknown as AgentRunContext)
    expect(withPreset).toContain('## Required plan shape')
    expect(plain).not.toContain('## Required plan shape')
    // A preset-less initiative and an initiative-less context both yield the same free-form prompt.
    expect(plain).toEqual(noInitiative)
  })
})

describe('initiative analyst prompt fold — phaseTemplate', () => {
  it('does NOT render the plan shape for the analyst (a prose step authors no phases)', () => {
    const analyst = initiativeAnalystUserPrompt(
      context({ preset: { label: 'X', phaseTemplate: TEMPLATE } }),
    )
    expect(analyst).not.toContain('## Required plan shape')
    expect(analyst).not.toContain('migration-blast-zone')
  })

  it('still renders the analyst promptAddition when present', () => {
    const analyst = initiativeAnalystUserPrompt(
      context({ preset: { label: 'Migration', promptAddition: 'Chase transitive callers.' } }),
    )
    expect(analyst).toContain('## Initiative preset: Migration')
    expect(analyst).toContain('Chase transitive callers.')
  })
})
