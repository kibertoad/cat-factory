import { describe, expect, it } from 'vitest'
import type { BootstrapJob } from './bootstrap.js'
import type { BootstrapRunShape } from './bootstrap-steps.js'
import {
  bootstrapReachedStep,
  bootstrapResumeStep,
  bootstrapRunSteps,
  bootstrapStepIdSchema,
} from './bootstrap-steps.js'

// Presence is all the rule reads off the target, which is why it is typed as one.
const monorepo = { repoOwner: 'acme', repoName: 'platform', directory: 'services/billing' }

function job(patch: Partial<BootstrapRunShape> = {}): BootstrapRunShape {
  return {
    monorepo: null,
    phase: null,
    status: 'running',
    adoptionPlan: null,
    adoptionReview: null,
    ...patch,
  }
}

/** A recorded plan, at the status the survey gave it: the only field the rule reads. */
function plan(status: 'ready' | 'unavailable') {
  return { status }
}

/** A settled review; again, presence is the whole of what the rule reads. */
const review = { choices: [] }

describe('bootstrapRunSteps', () => {
  it('gives a new-repo run one step carrying the run status', () => {
    expect(bootstrapRunSteps(job({ status: 'running' }))).toEqual([
      { id: 'scaffold', state: 'running' },
    ])
    expect(bootstrapRunSteps(job({ status: 'failed' }))).toEqual([
      { id: 'scaffold', state: 'failed' },
    ])
  })

  it('marks the steps before the reached one done and the ones after it pending', () => {
    // The apply is running: the survey happened and the review was answered, but a run that
    // died here never attempted anything after it, so nothing later is coloured as broken.
    expect(
      bootstrapRunSteps(
        job({ monorepo, phase: 'apply', adoptionReview: review, status: 'failed' }),
      ),
    ).toEqual([
      { id: 'survey', state: 'done' },
      { id: 'review', state: 'done' },
      { id: 'apply', state: 'failed' },
    ])
  })

  it('shows the park as its own state, not as a spinner', () => {
    expect(
      bootstrapRunSteps(
        job({ monorepo, phase: 'survey', status: 'awaiting_review', adoptionPlan: plan('ready') }),
      ),
    ).toEqual([
      { id: 'survey', state: 'done' },
      { id: 'review', state: 'awaiting_review' },
      { id: 'apply', state: 'pending' },
    ])
  })

  it('renders a status this build no longer defines as unreadable rather than as not-started', () => {
    // How it gets here: a row written by a build whose status vocabulary has since lost a
    // member. The switch is exhaustive against the TYPE, so only a cast can demonstrate the
    // runtime half, which is the half a stale row actually meets.
    const stale = job({ status: 'retired-status' as BootstrapJob['status'] })
    expect(bootstrapRunSteps(stale)).toEqual([{ id: 'scaffold', state: 'unknown' }])
  })

  it('names only steps the id vocabulary declares', () => {
    const ids = bootstrapRunSteps(job({ monorepo, phase: 'survey' })).map((step) => step.id)
    for (const id of ids) expect(bootstrapStepIdSchema.options).toContain(id)
  })
})

describe('bootstrapResumeStep', () => {
  it('resumes a failed apply at the apply, under the decisions already given', () => {
    const failedApply = job({
      monorepo,
      phase: 'apply',
      adoptionReview: review,
      adoptionPlan: plan('ready'),
      status: 'failed',
    })
    expect(bootstrapResumeStep(failedApply)).toBe('apply')
    expect(bootstrapReachedStep(failedApply)).toBe('apply')
  })

  it('resumes a run stopped while parked at the review it is still holding', () => {
    const parked = job({ monorepo, phase: 'survey', status: 'failed', adoptionPlan: plan('ready') })
    expect(bootstrapResumeStep(parked)).toBe('review')
  })

  it('re-surveys a run parked on a plan the platform could not produce', () => {
    // The one case where where it GOT to and where it RESUMES differ: the retry drops a
    // non-ready plan so a fixed deployment can produce a real one, and promising the reviewer
    // their pending decision is what resumes would be the wrong half of that.
    const unavailable = job({
      monorepo,
      phase: 'survey',
      status: 'failed',
      adoptionPlan: plan('unavailable'),
    })
    expect(bootstrapReachedStep(unavailable)).toBe('review')
    expect(bootstrapResumeStep(unavailable)).toBe('survey')
  })

  it('resumes a new-repo run at its only step', () => {
    expect(bootstrapResumeStep(job({ status: 'failed' }))).toBe('scaffold')
  })
})
