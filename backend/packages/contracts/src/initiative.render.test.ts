import { describe, expect, it } from 'vitest'
import {
  renderInitiativePlanForReview,
  type Initiative,
  type InitiativePlanDraft,
} from './initiative.js'

/**
 * The markdown the `initiative-planner`'s human gate parks on. Two things are being pinned,
 * and they are the two ways this document can lie to a reviewer:
 *
 *  - its HEADINGS, because the reader's outline parser splits the document at each one — a
 *    phase folded into a table is a phase nobody can navigate to or anchor a comment against;
 *  - its COMPLETENESS, because the reviewer's approval commits every item the initiative
 *    carries, including ones the document could easily have dropped on the floor.
 */
describe('renderInitiativePlanForReview', () => {
  const draft: InitiativePlanDraft = {
    goal: 'Migrate every repository off the legacy client.',
    constraints: ['No downtime'],
    nonGoals: ['Rewriting the CLI'],
    analysisSummary: 'The legacy client is reached from 4 packages.',
    phases: [
      { id: 'phase-one', title: 'Introduce the adapter', goal: 'Land the seam.' },
      { id: 'phase-two', title: 'Cut over', goal: '', checkpoint: true, maxConcurrent: 1 },
    ],
    items: [
      {
        id: 'item-1',
        phaseId: 'phase-one',
        title: 'Add the adapter port',
        description: 'Define the port in kernel and wire both facades.',
        dependsOn: [],
        estimate: { complexity: 0.4, risk: 0.2, impact: 0.8, rationale: 'Well-understood.' },
      },
      {
        id: 'item-2',
        phaseId: 'phase-two',
        title: 'Delete the legacy client',
        description: 'Remove the old module once every caller moved.',
        dependsOn: ['item-1'],
        pipelineId: 'pl_full',
      },
    ],
    policy: {
      maxConcurrent: 2,
      defaultPipelineId: 'pl_simple',
      rules: [{ pipelineId: 'pl_full', minRisk: 0.5 }],
      onMissingEstimate: 'default',
    },
    decisions: [{ title: 'Adapter over a rewrite', detail: 'Keeps each PR reviewable.' }],
    caveats: ['The legacy client has no tests.'],
  }

  it('renders every part of the plan under its own heading', () => {
    const out = renderInitiativePlanForReview(draft)
    expect(out).toContain('# Initiative plan')
    expect(out).toContain('## Goal')
    // Each phase and each item is a heading, so each becomes a ToC entry + comment anchor.
    expect(out).toContain('## Phase 1: Introduce the adapter')
    expect(out).toContain('## Phase 2: Cut over')
    expect(out).toContain('### Add the adapter port (item-1)')
    expect(out).toContain('### Delete the legacy client (item-2)')
    expect(out).toContain('Define the port in kernel and wire both facades.')
    expect(out).toContain('- Complexity: 40%')
    expect(out).toContain('- Impact: 80%')
    expect(out).toContain('- Rationale: Well-understood.')
    expect(out).toContain('Depends on: `item-1`')
    expect(out).toContain('Pipeline: `pl_full`')
    expect(out).toContain('Concurrency for this phase: 1.')
    // A checkpoint changes when the initiative pauses, so the reviewer must be told.
    expect(out).toContain('Checkpoint')
    expect(out).toContain('- Up to 2 items run at once.')
    expect(out).toContain('- Default pipeline: `pl_simple`.')
    expect(out).toContain('- `pl_full` when risk ≥ 50%.')
    expect(out).toContain('Adapter over a rewrite')
    expect(out).toContain('The legacy client has no tests.')
  })

  it('names a rule that declares no thresholds rather than implying it applies', () => {
    const out = renderInitiativePlanForReview({
      ...draft,
      policy: { ...draft.policy, rules: [{ pipelineId: 'pl_full' }] },
    })
    expect(out).toContain('`pl_full` when never matches (no thresholds declared).')
  })

  it('says a phase is empty instead of leaving nothing under its heading', () => {
    const out = renderInitiativePlanForReview({
      ...draft,
      items: draft.items.filter((i) => i.phaseId === 'phase-one'),
    })
    expect(out).toContain('## Phase 2: Cut over')
    expect(out).toContain('_No items in this phase._')
  })

  // An item's `phaseId` can name a phase the plan does not declare: a draft phase's `id` is
  // optional, and the reference validation only rejects a dangling `phaseId` once at least one
  // phase declares an id. Those items are ingested and DO execute, so the document that the
  // approval governs has to show them.
  it('surfaces items whose phase the plan never declared', () => {
    const out = renderInitiativePlanForReview({
      ...draft,
      phases: [{ title: 'Introduce the adapter' }, { title: 'Cut over' }],
    })
    expect(out).toContain('## Unplaced items')
    expect(out).toContain('### Add the adapter port (item-1)')
    expect(out).toContain('### Delete the legacy client (item-2)')
    expect(out).toContain('Declared phase: `phase-one`.')
    // Every item is accounted for exactly once — listed under a phase or listed as unplaced.
    expect(out.match(/### Add the adapter port/g)).toHaveLength(1)
  })

  it('has no unplaced section when every item sits in a declared phase', () => {
    expect(renderInitiativePlanForReview(draft)).not.toContain('## Unplaced items')
  })

  // The gate reviews the INGESTED entity, not the planner's draft — that is the whole point of
  // the renderer taking the shape both satisfy. An entity carries two things a draft cannot:
  // items a previous plan already materialised (carried over by the ingest), and their status.
  it('renders an ingested initiative, including carried-over items and their status', () => {
    const initiative = {
      id: 'init_1',
      blockId: 'blk_1',
      slug: 'legacy-client',
      title: 'Legacy client migration',
      goal: 'Migrate every repository off the legacy client.',
      constraints: [],
      nonGoals: [],
      qa: [],
      analysisSummary: '',
      phases: [{ id: 'phase-one', title: 'Introduce the adapter', goal: '' }],
      items: [
        {
          id: 'item-1',
          phaseId: 'phase-one',
          title: 'Add the adapter port',
          description: 'Define the port in kernel.',
          dependsOn: [],
          status: 'done' as const,
        },
        {
          id: 'item-2',
          phaseId: 'phase-one',
          title: 'Wire the second facade',
          description: 'Mirror the port on Node.',
          dependsOn: [],
          status: 'pending' as const,
        },
      ],
      policy: {
        maxConcurrent: 1,
        defaultPipelineId: 'pl_simple',
        rules: [],
        onMissingEstimate: 'default' as const,
      },
      decisions: [],
      deviations: [],
      followUps: [],
      caveats: [],
      status: 'awaiting_approval' as const,
      rev: 2,
      createdAt: 0,
      updatedAt: 0,
    } satisfies Initiative
    const out = renderInitiativePlanForReview(initiative)
    expect(out).toContain('### Add the adapter port (item-1)')
    // Already settled: the reviewer needs to know this one is not up for planning.
    expect(out).toContain('Status: `done`.')
    expect(out).toContain('- Up to 1 item run at once.')
    // `pending` is the norm for a fresh plan, so it stays unannotated.
    expect(out).not.toContain('Status: `pending`.')
  })

  it('states an absent policy rather than dropping the section', () => {
    const out = renderInitiativePlanForReview({ phases: [], items: [], policy: null })
    expect(out).toContain('## Execution policy')
    expect(out).toContain('_No execution policy has been agreed yet._')
  })
})
