import { describe, expect, it } from 'vitest'
import type { AgentRunResult } from '@cat-factory/kernel'
import { reviewableArtifactOutput } from './artifact-review.logic.js'

describe('reviewableArtifactOutput', () => {
  it('renders a spec doc instead of the raw transcript summary', () => {
    const result: AgentRunResult = {
      output: '[spec-writer] raw transcript chatter, tool calls, cut off mid-tok',
      spec: {
        service: 'main-service',
        summary: 'A CRUD service.',
        modules: [
          {
            name: 'Estate',
            summary: 'Estate management.',
            groups: [
              {
                name: 'Buildings',
                summary: 'Manage buildings.',
                requirements: [
                  {
                    id: 'req-create-building',
                    title: 'Create building',
                    statement: 'The system SHALL create a building.',
                    kind: 'functional',
                    priority: 'must',
                    acceptance: [
                      {
                        id: 'ac-1',
                        given: 'a valid payload',
                        when: 'POST /buildings',
                        outcome: '201 returned',
                      },
                    ],
                  },
                ],
                rules: [{ id: 'rule-1', rule: 'Names are unique.', rationale: 'avoid clashes' }],
              },
            ],
          },
        ],
      },
    }
    const out = reviewableArtifactOutput(result)
    expect(out).toBeDefined()
    // The actual document is what a companion must grade — not the transcript.
    expect(out).not.toContain('raw transcript chatter')
    expect(out).toContain('# Specification: main-service')
    expect(out).toContain('Create building')
    expect(out).toContain('The system SHALL create a building.')
    expect(out).toContain('GIVEN a valid payload WHEN POST /buildings THEN 201 returned')
    expect(out).toContain('Names are unique.')
  })

  it('renders a blueprint tree instead of the raw transcript summary', () => {
    const result: AgentRunResult = {
      output: '[blueprints] raw chatter',
      blueprintService: {
        type: 'service',
        name: 'billing',
        summary: 'Handles billing.',
        references: ['package.json'],
        modules: [
          { name: 'Invoices', summary: 'Invoice lifecycle.', references: ['src/invoices'] },
        ],
      },
    }
    const out = reviewableArtifactOutput(result)
    expect(out).toContain('# Service: billing (service)')
    expect(out).toContain('## Module: Invoices')
    expect(out).toContain('Invoice lifecycle.')
    expect(out).not.toContain('raw chatter')
  })

  it('renders the initiative plan instead of the raw transcript summary', () => {
    const result: AgentRunResult = {
      output: 'Initiative plan drafted.',
      initiativePlan: {
        goal: 'Migrate every repository off the legacy client.',
        constraints: ['No downtime'],
        nonGoals: ['Rewriting the CLI'],
        analysisSummary: 'The legacy client is reached from 4 packages.',
        phases: [
          { id: 'phase-one', title: 'Introduce the adapter', goal: 'Land the seam.' },
          { id: 'phase-two', title: 'Cut over', checkpoint: true },
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
        },
        decisions: [{ title: 'Adapter over a rewrite', detail: 'Keeps each PR reviewable.' }],
        caveats: ['The legacy client has no tests.'],
      },
    }
    const out = reviewableArtifactOutput(result)
    expect(out).toBeDefined()
    // The plan itself is what the human gate parks on — not the planner's one-line summary.
    expect(out).not.toContain('Initiative plan drafted.')
    expect(out).toContain('# Initiative plan')
    // Headings are what the reader's outline turns into navigable ToC entries.
    expect(out).toContain('## Phase 1: Introduce the adapter')
    expect(out).toContain('## Phase 2: Cut over')
    expect(out).toContain('### Add the adapter port (item-1)')
    expect(out).toContain('Define the port in kernel and wire both facades.')
    expect(out).toContain('- Complexity: 40%')
    expect(out).toContain('- Impact: 80%')
    expect(out).toContain('Depends on: `item-1`')
    expect(out).toContain('Pipeline: `pl_full`')
    expect(out).toContain('- Up to 2 items run at once.')
    expect(out).toContain('- `pl_full` when risk ≥ 50%.')
    expect(out).toContain('Adapter over a rewrite')
    expect(out).toContain('The legacy client has no tests.')
    expect(out).toContain('Checkpoint')
  })

  it('falls back to undefined for a prose producer (no artifact)', () => {
    expect(
      reviewableArtifactOutput({ output: 'An architecture proposal in prose.' }),
    ).toBeUndefined()
  })

  it('falls back to undefined when the artifact is present but malformed', () => {
    expect(reviewableArtifactOutput({ output: 'x', spec: { not: 'a spec' } })).toBeUndefined()
    expect(
      reviewableArtifactOutput({ output: 'x', blueprintService: { bad: true } }),
    ).toBeUndefined()
    expect(
      reviewableArtifactOutput({ output: 'x', initiativePlan: { phases: 'not an array' } }),
    ).toBeUndefined()
  })
})
