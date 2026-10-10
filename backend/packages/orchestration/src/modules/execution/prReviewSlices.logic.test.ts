import { describe, expect, it } from 'vitest'
import type { PipelineStep, PrReviewSliceReview } from '@cat-factory/kernel'
import {
  applySliceReviews,
  coerceSliceReviews,
  mergeSliceReviews,
  planResumeSlices,
  sliceReviewsAfterAggregation,
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

describe('sliceReviewsAfterAggregation', () => {
  const kept = [review('api', 'completed', 'body')]

  it('drops the reports once findings landed — their content is in the findings', () => {
    expect(sliceReviewsAfterAggregation(kept, { slices: ['s'], findings: ['f'] })).toEqual([])
  })

  it('drops them for a genuinely clean PR, which still names its slices', () => {
    expect(sliceReviewsAfterAggregation(kept, { slices: ['s'], findings: [] })).toEqual([])
  })

  it('KEEPS them when the reviewer aggregated nothing at all', () => {
    // Neither slices nor findings means nothing consumed the reports. Clearing here would destroy
    // the only record of the finished slices AND record the run as a clean PR — the exact loss this
    // channel prevents, wearing a pass as a disguise. Keeping them leaves the review resumable.
    expect(sliceReviewsAfterAggregation(kept, { slices: [], findings: [] })).toEqual(kept)
  })

  it('is empty when there was nothing to keep', () => {
    expect(sliceReviewsAfterAggregation(undefined, { slices: [], findings: [] })).toEqual([])
  })
})

describe('planResumeSlices', () => {
  const planned = (...entries: [string, 'pending' | 'in_progress' | 'completed'][]) =>
    entries.map(([label, status]) => ({ label, status }))

  it('redoes only what never completed, and never the aggregation entry', () => {
    // The resume's whole value is not re-reviewing finished work. The aggregation entry is not a
    // slice and a resume re-aggregates unconditionally, so listing it would tell the reviewer to
    // "review" its own final step.
    const pending = planResumeSlices(
      [review('api', 'completed', 'body'), review('infra', 'in_progress')],
      planned(['api', 'completed'], ['infra', 'in_progress'], ['aggregate findings', 'pending']),
    )
    expect(pending).toEqual(['infra'])
  })

  it('names a planned slice that was never dispatched', () => {
    // The task list is the ONLY place such a slice appears — the slice reviews can describe
    // nothing but subagents that actually started, so deriving the set from them alone would
    // silently drop everything the reviewer planned but never got to.
    const pending = planResumeSlices(
      [review('api', 'completed', 'body')],
      planned(['api', 'completed'], ['docs', 'pending'], ['aggregate findings', 'pending']),
    )
    expect(pending).toEqual(['docs'])
  })

  it('includes an in-flight slice the plan never mentioned', () => {
    // A reviewer that regrouped mid-run, or never wrote a parent plan at all (ADR 0026 D2.2),
    // leaves dispatched work the task list does not describe.
    expect(planResumeSlices([review('orphan', 'in_progress')], [])).toEqual(['orphan'])
  })

  it('is empty when every planned slice completed — the resume only re-aggregates', () => {
    // The motivating incident's exact shape: all slices reported, the aggregation pass wedged.
    const pending = planResumeSlices(
      [review('api', 'completed', 'a'), review('infra', 'completed', 'b')],
      planned(['api', 'completed'], ['infra', 'completed'], ['aggregate findings', 'in_progress']),
    )
    expect(pending).toEqual([])
  })

  it('pairs labels case- and whitespace-insensitively, and reports the original casing', () => {
    // The harness reduces both label vocabularies (the todo entry and the subagent dispatch
    // description) to the same key, so the plan and the reports routinely differ in casing.
    expect(
      planResumeSlices(
        [review('API Correlation', 'completed', 'body')],
        planned(['api  ', 'pending']),
      ),
    ).toEqual(['api'])
    expect(planResumeSlices([], planned([' Docs Config ', 'pending']))).toEqual(['Docs Config'])
  })

  it('deduplicates and keeps the plan order, so the resume takes the slices as planned', () => {
    const pending = planResumeSlices(
      [review('b', 'in_progress')],
      planned(['a', 'pending'], ['b', 'in_progress'], ['a', 'pending']),
    )
    expect(pending).toEqual(['a', 'b'])
  })

  it('drops a blank label, which nothing can be dispatched against', () => {
    expect(planResumeSlices([], planned(['   ', 'pending']))).toEqual([])
  })
})
