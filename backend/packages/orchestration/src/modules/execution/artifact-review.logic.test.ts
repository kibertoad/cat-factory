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

  // The initiative plan is DELIBERATELY not handled here, and this pins that rather than
  // leaving it to be "fixed" by a future reader who spots the missing artifact. This seam
  // renders the agent's RAW result, which is only sound while the committed artifact IS that
  // result. The plan is reshaped at ingest (a preset's phase template reorders phases; its
  // `seedPlan` hook adds and drops items), so rendering the raw draft here would show a
  // reviewer a document their approval does not govern. Its rendering is authored by the
  // `initiative-planner` step resolver, off the INGESTED entity.
  it('leaves the initiative plan alone — its rendering is authored at ingest', () => {
    const result: AgentRunResult = {
      output: 'Initiative plan drafted.',
      initiativePlan: {
        goal: 'Migrate every repository off the legacy client.',
        phases: [{ id: 'phase-one', title: 'Introduce the adapter' }],
        items: [{ id: 'item-1', phaseId: 'phase-one', title: 'Add the adapter port' }],
        policy: { maxConcurrent: 2, defaultPipelineId: 'pl_simple' },
      },
    }
    expect(reviewableArtifactOutput(result)).toBeUndefined()
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
  })
})
