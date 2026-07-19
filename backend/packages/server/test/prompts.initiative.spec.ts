import { describe, expect, it } from 'vitest'
import type { AgentKind, AgentRunContext } from '@cat-factory/kernel'
import type { InitiativePresetPhaseTemplate } from '@cat-factory/contracts'
import {
  defaultAgentKindRegistry,
  initiativeAnalystUserPrompt,
  initiativePlannerUserPrompt,
  userPromptFor,
} from '@cat-factory/agents'

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

function context(
  over: NonNullable<AgentRunContext['initiative']> = {},
  agentKind: AgentKind = 'initiative-planner',
): AgentRunContext {
  return {
    agentKind,
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

// Preset steering (a preset's `promptAddition`) is NOT rendered by the initiative prompt builders
// themselves — it is applied CENTRALLY by `userPromptFor` → `buildBaseUserPrompt`, which prepends
// `initiativePresetSection` to every registered kind's own prompt. These tests exercise that real
// resolution path (the one the engine dispatches through) and guard against the section being
// emitted twice — the regression from lifting the builders onto the `registerAgentKind` seam.
describe('initiative preset steering — resolved through userPromptFor', () => {
  const registry = defaultAgentKindRegistry()
  // Count non-overlapping occurrences of a literal substring.
  const occurrences = (haystack: string, needle: string): number =>
    haystack.split(needle).length - 1

  it('renders the planner promptAddition heading exactly once, above the task', () => {
    const ctx = context({
      preset: { label: 'Technological migration', promptAddition: 'Be careful.' },
    })
    const prompt = userPromptFor(ctx, registry, { materialized: true })
    expect(occurrences(prompt, '## Initiative preset: Technological migration')).toBe(1)
    expect(prompt).toContain('Be careful.')
    // A promptAddition-only preset carries no phase template ⇒ no plan-shape section.
    expect(prompt).not.toContain('## Required plan shape')
    // The preset steering frames the role FIRST — before the "Plan the initiative:" task line.
    expect(prompt.indexOf('## Initiative preset')).toBeLessThan(
      prompt.indexOf('Plan the initiative'),
    )
  })

  it('renders the analyst promptAddition heading exactly once', () => {
    const ctx = context(
      { preset: { label: 'Migration', promptAddition: 'Chase transitive callers.' } },
      'initiative-analyst',
    )
    const prompt = userPromptFor(ctx, registry, { materialized: true })
    expect(occurrences(prompt, '## Initiative preset: Migration')).toBe(1)
    expect(prompt).toContain('Chase transitive callers.')
  })

  it('does not duplicate the preset section when a preset carries BOTH an addition and a phase template', () => {
    const ctx = context({
      preset: {
        label: 'Technological migration',
        promptAddition: 'Be careful.',
        phaseTemplate: TEMPLATE,
      },
    })
    const prompt = userPromptFor(ctx, registry, { materialized: true })
    // The preset heading (from the central prepend) and the plan shape (from the builder) each
    // appear exactly once — no double-render from the builder self-rendering preset steering.
    expect(occurrences(prompt, '## Initiative preset: Technological migration')).toBe(1)
    expect(occurrences(prompt, '## Required plan shape')).toBe(1)
  })
})

describe('initiative analyst prompt fold — phaseTemplate', () => {
  it('does NOT render the plan shape for the analyst (a prose step authors no phases)', () => {
    const analyst = initiativeAnalystUserPrompt(
      context({ preset: { label: 'X', phaseTemplate: TEMPLATE } }, 'initiative-analyst'),
    )
    expect(analyst).not.toContain('## Required plan shape')
    expect(analyst).not.toContain('migration-blast-zone')
  })
})
