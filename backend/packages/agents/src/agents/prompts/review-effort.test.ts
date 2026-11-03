import type { AgentRunContext } from '@cat-factory/kernel'
import { REVIEW_EFFORT_LEVELS } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { userPromptFor } from '../catalog.js'
import { defaultAgentKindRegistry } from '../kinds/registry.js'
import { MAX_PARALLEL_SLICE_SUBAGENTS } from '../kinds/pr-reviewer.js'
import { reviewEffortSection, UNCONFIRMED_FINDING_MARKER } from './review-effort.js'

function context(over: Partial<AgentRunContext>): AgentRunContext {
  return {
    agentKind: 'pr-reviewer',
    pipelineName: 'review',
    stepIndex: 0,
    isFinalStep: true,
    block: { title: 'Review PR #42', type: 'service', description: 'Review pull request #42.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as unknown as AgentRunContext
}

/** The findings cap a section states, or null when it states none. */
function capOf(section: string): number | null {
  const match = /Report at most (\d+) /.exec(section)
  return match ? Number(match[1]) : null
}

describe('reviewEffortSection', () => {
  it('raises the findings cap with every level, and lifts it at max', () => {
    const caps = REVIEW_EFFORT_LEVELS.map((level) =>
      capOf(reviewEffortSection(level, 'pr-reviewer')),
    )
    const bounded = caps.slice(0, -1) as number[]
    for (let i = 1; i < bounded.length; i++) expect(bounded[i]!).toBeGreaterThan(bounded[i - 1]!)
    expect(caps.at(-1)).toBeNull()
  })

  it('reports unconfirmed findings only at the two highest levels, and marks them', () => {
    const marks = REVIEW_EFFORT_LEVELS.map((level) =>
      reviewEffortSection(level, 'pr-reviewer').includes(UNCONFIRMED_FINDING_MARKER),
    )
    expect(marks).toEqual([false, false, false, true, true])
  })

  it('runs a verification pass from high upwards, and says there is none below', () => {
    expect(reviewEffortSection('medium', 'pr-reviewer')).toMatch(/no separate verification pass/)
    for (const level of ['high', 'xhigh', 'max'] as const) {
      expect(reviewEffortSection(level, 'pr-reviewer')).toMatch(/VERIFY each candidate finding/)
    }
  })

  it('never widens the slice fan-out past the rate-limit window', () => {
    for (const level of REVIEW_EFFORT_LEVELS) {
      const match = /keep at most (\d+) slice reviewers/.exec(
        reviewEffortSection(level, 'pr-reviewer'),
      )
      expect(Number(match![1])).toBeLessThanOrEqual(MAX_PARALLEL_SLICE_SUBAGENTS)
    }
  })

  it('gives the companion no slice instructions and keeps unconfirmed points off blockers', () => {
    const section = reviewEffortSection('max', 'companion')
    expect(section).not.toMatch(/slice/)
    expect(section).toMatch(/Never raise an unconfirmed point as a `blocker`/)
  })

  it('pins that the level never moves how severity is graded', () => {
    for (const level of REVIEW_EFFORT_LEVELS) {
      expect(reviewEffortSection(level, 'companion')).toMatch(/never changes how you grade/)
    }
  })
})

describe('userPromptFor with a review effort', () => {
  const registry = defaultAgentKindRegistry()

  it('states the level for the pr-reviewer in its slicing form', () => {
    const out = userPromptFor(context({ reviewEffort: 'low' }), registry)
    expect(out).toContain('## Review effort: low')
    expect(out).toMatch(/slice reviewers/)
  })

  it('states the level for the post-implementation reviewer in its companion form', () => {
    const out = userPromptFor(context({ agentKind: 'reviewer', reviewEffort: 'xhigh' }), registry)
    expect(out).toContain('## Review effort: extra high')
    expect(out).not.toMatch(/slice reviewers/)
  })

  it('leaves a prompt with no effort level untouched', () => {
    expect(userPromptFor(context({ agentKind: 'coder' }), registry)).not.toContain('Review effort')
  })
})
