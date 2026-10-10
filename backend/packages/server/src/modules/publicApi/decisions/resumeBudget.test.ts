import { PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS } from '@cat-factory/contracts'
import type { ExecutionInstance, PipelineStep, PrReviewStepState } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { prReviewResumeRefusal, prReviewResumesSpent } from './resumeBudget.js'

// The ceiling on the public resume, which is the one loop a KEY drives and the only one that was
// unbounded. Asserted here rather than through the wire because the state it is about is not
// reachable there: a resume needs a reviewer wedged mid-review, which a conformance drive (where
// the fake reviewer returns within the same tick) never produces. What the wire DOES cover is the
// route itself, through the parked-review 409.

const review = (over: Partial<PrReviewStepState> = {}): PrReviewStepState =>
  ({ status: 'reviewing', resumeAttempts: 0, ...over }) as PrReviewStepState

const step = (over: Partial<PipelineStep> = {}): PipelineStep =>
  ({ agentKind: 'pr-reviewer', state: 'working', progress: 0, ...over }) as PipelineStep

const run = (steps: PipelineStep[]): Pick<ExecutionInstance, 'steps'> => ({ steps })

describe('prReviewResumesSpent', () => {
  it('is zero for a run with no review, and for a review nobody nudged', () => {
    expect(prReviewResumesSpent(run([step()]))).toBe(0)
    expect(prReviewResumesSpent(run([step({ prReview: review() })]))).toBe(0)
  })

  it('takes the MAXIMUM across the steps, not the last one it walks past', () => {
    // A chain can carry two `pr-reviewer` steps (a second review after a rework), and the count
    // lives on each step's own state. Reading the last one would hand a spent review a fresh
    // budget as soon as a later step started a review of its own.
    expect(
      prReviewResumesSpent(
        run([
          step({ prReview: review({ resumeAttempts: 3, status: 'done' }) }),
          step({ prReview: review({ resumeAttempts: 1 }) }),
        ]),
      ),
    ).toBe(3)
  })
})

describe('prReviewResumeRefusal', () => {
  it('allows every resume below the ceiling', () => {
    for (let spent = 0; spent < PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS; spent++) {
      expect(
        prReviewResumeRefusal(run([step({ prReview: review({ resumeAttempts: spent }) })])),
        `spent ${spent}`,
      ).toBeNull()
    }
  })

  it('refuses AT the ceiling, naming the evidence to read instead and both exits', () => {
    // The refusal has to leave the caller somewhere to go: what it reads to tell a wedged review
    // from a slow one, and the two ways out that are not another resume. A bare "no" would send a
    // poller into the same call on its next tick.
    const refusal = prReviewResumeRefusal(
      run([step({ prReview: review({ resumeAttempts: PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS }) })]),
    )
    expect(refusal).toContain(`resumed ${PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS} times`)
    expect(refusal).toContain('lastActivityAt')
    expect(refusal).toContain('from the app')
    expect(refusal).toContain('POST /api/v1/tasks/:taskId/stop')
  })

  it('stays refused PAST the ceiling', () => {
    // The app's resume is uncapped, so a review can arrive here already over budget. `>=` rather
    // than `===` is what keeps that a refusal instead of an off-by-one that lets it through.
    expect(
      prReviewResumeRefusal(
        run([
          step({ prReview: review({ resumeAttempts: PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS + 5 }) }),
        ]),
      ),
    ).not.toBeNull()
  })
})
