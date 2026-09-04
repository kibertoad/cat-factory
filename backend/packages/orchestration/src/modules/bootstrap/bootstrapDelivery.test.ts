import type { BootstrapJobRecord } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { defaultDelivery, deliveryPlanFor } from './bootstrapDelivery.js'

/** A stored run carrying only what the delivery plan reads off it. */
function record(overrides: Partial<BootstrapJobRecord> = {}): BootstrapJobRecord {
  return {
    id: 'boot_1',
    workspaceId: 'ws_1',
    referenceArchitectureId: null,
    referenceArchitectureName: null,
    repoName: 'payments',
    repoOwner: null,
    repoUrl: null,
    instructions: 'A payments service.',
    status: 'running',
    blockId: null,
    subtasks: null,
    error: null,
    failure: null,
    monorepo: null,
    phase: null,
    delivery: 'pull_request',
    workBranch: 'cat-factory/bootstrap-boot_1',
    driveId: 'boot_1',
    adoptionPlan: null,
    adoptionReview: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('defaultDelivery', () => {
  it('reviews a monorepo and pushes a repository it is creating', () => {
    // The whole reason the rule is code rather than a schema default: the two targets want
    // opposite answers, so a single constant would be wrong for one of them.
    expect(defaultDelivery(true)).toBe('pull_request')
    expect(defaultDelivery(false)).toBe('direct_push')
  })
})

describe('deliveryPlanFor', () => {
  it('carries no branch and no pull request when the run pushes directly', () => {
    // The two fields are meaningless apart: a plan with a branch and no PR would push work onto
    // a branch nobody is ever told about, which is neither toggle position.
    expect(deliveryPlanFor(record({ delivery: 'direct_push' }))).toEqual({ mode: 'direct_push' })
  })

  it('takes the branch the run RECORDED, not one derived from the id it is dispatching under', () => {
    // This is what makes a retry resume: a retry is a NEW row with a new id carrying the first
    // attempt's branch forward, so a plan derived from `record.id` would mint a second branch,
    // the harness's resume would never fire, and the first attempt's pushed commits would be
    // abandoned where nobody looks.
    const retried = record({ id: 'boot_2', workBranch: 'cat-factory/bootstrap-boot_1' })
    const plan = deliveryPlanFor(retried)
    expect(plan.mode === 'pull_request' && plan.branch).toBe('cat-factory/bootstrap-boot_1')
  })

  it('claims a branch off its own id for a row written before the branch was recorded', () => {
    // Internals carry no migrations, so a row predating the field reads null. Answering with a
    // null branch would dispatch a pull-request run with nothing to push.
    const plan = deliveryPlanFor(record({ id: 'boot_9', workBranch: null }))
    expect(plan.mode === 'pull_request' && plan.branch).toBe('cat-factory/bootstrap-boot_9')
  })

  it('neutralises the reference name in the fallback body instead of auto-linking off it', () => {
    // The name is free text somebody typed, and the body lands on a pull request where `#42`
    // cross-references an issue and a closing keyword before one CLOSES it on merge. The hole is
    // a code span, so `inlineCode` has to size the fence around whatever backticks it contains:
    // a hand-written pair would be closed by the value's own tick, spilling `#42` into prose.
    const plan = deliveryPlanFor(record({ referenceArchitectureName: 'acme `#42` base' }))
    const body = plan.mode === 'pull_request' ? plan.pr.body : ''
    expect(body).toContain('``acme `#42` base``')
    expect(body).not.toMatch(/[^`]#42[^`]/)
  })

  it('scrubs a secret pasted into the reference name', () => {
    // A PR body is strictly more exposed than the telemetry DB, and the monorepo half of this
    // function has always redacted. The new-repo half must not be the one hole that does not.
    const plan = deliveryPlanFor(
      record({ referenceArchitectureName: 'base ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }),
    )
    const body = plan.mode === 'pull_request' ? plan.pr.body : ''
    expect(body).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
  })
})
