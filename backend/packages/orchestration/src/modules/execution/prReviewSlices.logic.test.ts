import { describe, expect, it } from 'vitest'
import type { PipelineStep, PrReviewSliceReview } from '@cat-factory/kernel'
import {
  applySliceReviews,
  coerceSliceReviews,
  mergeSliceReviews,
} from './prReviewSlices.logic.js'

const review = (
  label: string,
  status: 'in_progress' | 'completed',
  report?: string | null,
): PrReviewSliceReview => ({ label, status, report: report ?? null })

function reviewStep(sliceReviews: PrReviewSliceReview[] = []): PipelineStep {
  return {
    agentKind: 'pr-reviewer',
    prReview: {
      status: 'reviewing',
      summary: null,
      slices: [],
      sliceReviews,
      findings: [],
      selectedFindingIds: [],
      resolution: null,
      prUrl: null,
      model: null,
      reviewedHeadSha: null,
      postReport: null,
      postedFindingIds: [],
      postedBody: false,
    },
  } as unknown as PipelineStep
}

describe('coerceSliceReviews', () => {
  it('keeps the good entries beside a malformed one', () => {
    // Per-entry leniency is the point: discarding seven valid reports because an eighth was
    // malformed would cause exactly the data loss this channel exists to prevent.
    const out = coerceSliceReviews([
      review('api-correlation', 'completed', 'found a bug'),
      { nonsense: true },
      review('infra-logging', 'in_progress'),
    ])
    expect(out.map((r) => r.label)).toEqual(['api-correlation', 'infra-logging'])
  })

  it('drops an unlabelled entry, which nothing can key on', () => {
    expect(coerceSliceReviews([review('   ', 'completed', 'body')])).toEqual([])
  })

  it('lets a completed duplicate win over an in-flight one', () => {
    // A retried subagent reports the same label twice; the completed result must not be demoted,
    // or a resume would re-review work it already holds.
    const out = coerceSliceReviews([
      review('docs-config', 'in_progress'),
      review('docs-config', 'completed', 'the report'),
    ])
    expect(out).toEqual([review('docs-config', 'completed', 'the report')])
  })

  it('is empty for a non-array payload', () => {
    expect(coerceSliceReviews(undefined)).toEqual([])
    expect(coerceSliceReviews('nope')).toEqual([])
  })
})

describe('applySliceReviews', () => {
  it('folds reports onto a reviewer step', () => {
    const step = reviewStep()
    expect(applySliceReviews(step, [review('api-correlation', 'completed', 'body')])).toBe(true)
    expect(step.prReview!.sliceReviews).toEqual([review('api-correlation', 'completed', 'body')])
  })

  it('reports no change on an identical republish', () => {
    // The harness republishes the whole set every poll, so an unchanged set must not rewrite the run.
    const step = reviewStep([review('a', 'completed', 'body')])
    expect(applySliceReviews(step, [review('a', 'completed', 'body')])).toBe(false)
  })

  it('ignores a step that carries no review', () => {
    const step = { agentKind: 'coder' } as unknown as PipelineStep
    expect(applySliceReviews(step, [review('a', 'completed', 'body')])).toBe(false)
  })

  it('never drops a completed report a later attempt no longer mentions', () => {
    // A restarted container's tracker only knows the slices IT dispatched. Forwarding that
    // verbatim would erase the previous attempt's reports, which are the preserved work.
    const step = reviewStep([review('done-earlier', 'completed', 'earlier body')])
    applySliceReviews(step, [review('fresh', 'in_progress')])
    expect(step.prReview!.sliceReviews!.map((r) => r.label).sort()).toEqual([
      'done-earlier',
      'fresh',
    ])
  })
})

describe('mergeSliceReviews', () => {
  it('does not demote a completed slice to in_progress', () => {
    const merged = mergeSliceReviews(
      [review('a', 'completed', 'body')],
      [review('a', 'in_progress')],
    )
    expect(merged).toEqual([review('a', 'completed', 'body')])
  })

  it('upgrades an in-flight slice once its report lands', () => {
    const merged = mergeSliceReviews([review('a', 'in_progress')], [review('a', 'completed', 'b')])
    expect(merged).toEqual([review('a', 'completed', 'b')])
  })
})
