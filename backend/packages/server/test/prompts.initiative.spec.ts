import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import type { InitiativePresetPhaseTemplate } from '@cat-factory/contracts'
import { initiativeAnalystUserPrompt, initiativePlannerUserPrompt } from '@cat-factory/agents'

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
    // The presence directive must NOT contradict the (optional) marker: an optional phase is
    // explicitly droppable, while required phases stay mandatory.
    expect(exhaustive).toContain('you may omit an (optional) phase')
    expect(exhaustive).toContain('Every phase NOT marked (optional) must be present')
    // Fidelity + exhaustiveness are worded so they don't demand keeping every listed phase.
    expect(exhaustive).toContain('do NOT rename, reorder or merge phases')
    expect(exhaustive).toContain('Do NOT introduce any phase beyond this set')
    // The flat all-present line is reserved for all-required templates; it must not appear here.
    expect(exhaustive).not.toContain('Every phase above must be present.')

    const open = initiativePlannerUserPrompt(
      context({
        preset: { label: 'X', phaseTemplate: { ...TEMPLATE, allowAdditionalPhases: true } },
      }),
    )
    expect(open).toContain('You MAY append further phases')
    // The open policy governs only ADDING phases; it must not re-assert that every listed phase
    // (including the optional one) has to be present.
    expect(open).toContain('you may omit an (optional) phase')
    expect(open).not.toContain('Do NOT introduce any phase beyond this set')
  })

  it('states a flat "every phase must be present" for an all-required template (no optional carve-out)', () => {
    const allRequired: InitiativePresetPhaseTemplate = {
      phases: [
        { id: 'a', title: 'A', goal: '', required: true },
        { id: 'b', title: 'B', goal: '', required: true },
      ],
      allowAdditionalPhases: false,
    }
    const prompt = initiativePlannerUserPrompt(
      context({ preset: { label: 'X', phaseTemplate: allRequired } }),
    )
    expect(prompt).toContain('Every phase above must be present.')
    // No optional phases ⇒ no "(optional)" marker and no droppable-phase clause.
    expect(prompt).not.toContain('(optional)')
    expect(prompt).not.toContain('you may omit')
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
