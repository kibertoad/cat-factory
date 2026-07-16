import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { systemPromptFor, userPromptFor } from '../catalog.js'
import { FINAL_ANSWER_IN_REPLY } from '../prompts/shared.js'
import { READ_ONLY_GUARDRAIL } from './read-only.js'
import { defaultAgentKindRegistry } from './registry.js'
import { SPIKE_KIND, spikeFindings } from './spike.js'

// `defaultAgentKindRegistry()` pre-loads the built-in spike kind, so a fresh instance exposes it
// (no module-global side effect).
const registry = defaultAgentKindRegistry()

/** A minimal spike run context; callers override the block fields they care about. */
function ctx(overrides: Partial<AgentRunContext['block']> = {}): AgentRunContext {
  return {
    agentKind: SPIKE_KIND,
    pipelineName: 'Run a spike',
    block: {
      id: 'b1',
      title: 'Evaluate queue options',
      type: 'backend',
      description: 'Decide whether to use pg-boss or a Redis-backed queue.',
      ...overrides,
    },
    decisions: [],
    priorOutputs: [],
  } as unknown as AgentRunContext
}

describe('spike agent kind', () => {
  it('registers a read-only container-explore kind that routes to the container executor', () => {
    const step = registry.agentStep(SPIKE_KIND)
    expect(step?.surface).toBe('container-explore')
    // Reads the repo AS-IS (base branch); it never edits or opens a PR.
    expect(step?.clone?.branch).toBe('base')
    expect(registry.requiresContainer(SPIKE_KIND)).toBe(true)
  })

  it('derives the structured output spec from the findings schema and fails on an unusable final', () => {
    expect(registry.agentStep(SPIKE_KIND)?.output).toEqual(spikeFindings.spec)
    expect(spikeFindings.spec.kind).toBe('structured')
    // The findings object IS the deliverable, so an unusable final answer fails the run.
    expect(spikeFindings.spec.failOnUnusableFinal).toBe(true)
  })

  it('surfaces presentation that opens the generic structured result view', () => {
    const presentation = registry.presentation(SPIKE_KIND)
    expect(presentation?.label).toBe('Spike')
    expect(presentation?.category).toBe('review')
    expect(presentation?.resultView).toBe('generic-structured')
  })

  it('does no repo writes (no pre/post-ops) — its whole product is the findings on result.custom', () => {
    expect(registry.preOps(SPIKE_KIND)).toEqual([])
    expect(registry.postOps(SPIKE_KIND)).toEqual([])
  })

  it('appends the read-only guardrail + final-answer-in-reply surface directives', () => {
    // Auto-applied for a registered container-explore kind (applySurfaceDirectives), so the spike
    // never edits and a reasoning model can't lose the findings to its hidden channel.
    const prompt = systemPromptFor(SPIKE_KIND, registry)
    expect(prompt).toContain(READ_ONLY_GUARDRAIL)
    expect(prompt).toContain(FINAL_ANSWER_IN_REPLY)
    // The core role frames it as a timeboxed, code-free investigation.
    expect(prompt).toContain('timeboxed SPIKE')
    expect(prompt).toContain('you write no code')
  })

  it('folds the investigation criteria (research question, options, timebox) into the user prompt', () => {
    const prompt = userPromptFor(
      ctx({
        taskTypeFields: {
          researchQuestion: 'Which queue best fits our workload?',
          optionsToCompare: 'pg-boss vs BullMQ',
          timeboxHours: 4,
        },
      }),
      registry,
      { materialized: true },
    )
    expect(prompt).toContain('Investigation criteria:')
    expect(prompt).toContain('Research question: Which queue best fits our workload?')
    expect(prompt).toContain('Options to compare: pg-boss vs BullMQ')
    expect(prompt).toContain('Timebox: ~4 hours')
  })

  it('omits the criteria section entirely on a bare spike task', () => {
    const prompt = userPromptFor(ctx(), registry, { materialized: true })
    expect(prompt).not.toContain('Investigation criteria:')
    expect(prompt).toContain('Spike: Evaluate queue options')
  })

  it('parses well-formed findings (options + recommendation + confidence)', () => {
    const findings = spikeFindings.parse({
      question: 'Which queue best fits our workload?',
      findings: 'pg-boss reuses our Postgres; BullMQ needs a Redis dependency we do not run.',
      optionsCompared: [
        { option: 'pg-boss', pros: ['no new infra'], cons: ['lower throughput ceiling'] },
        { option: 'BullMQ', pros: ['high throughput'], cons: ['adds Redis'], notes: 'ops cost' },
      ],
      recommendation: 'Use pg-boss.',
      openQuestions: ['What is our peak enqueue rate?'],
      confidence: 'high',
    })
    expect(findings.recommendation).toBe('Use pg-boss.')
    expect(findings.optionsCompared).toHaveLength(2)
    expect(findings.confidence).toBe('high')
  })

  it('degrades gracefully: a malformed confidence falls back to medium, lists to empty', () => {
    const findings = spikeFindings.safeParse({
      findings: 'Best-effort write-up.',
      confidence: 'nonsense',
      optionsCompared: 'not-an-array',
      openQuestions: 42,
    })
    expect(findings).toBeDefined()
    expect(findings?.findings).toBe('Best-effort write-up.')
    expect(findings?.confidence).toBe('medium')
    expect(findings?.optionsCompared).toEqual([])
    expect(findings?.openQuestions).toEqual([])
  })
})
