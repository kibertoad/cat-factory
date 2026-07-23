import { describe, expect, it } from 'vitest'
import type { Notification } from './notifications.js'
import type { WorkspaceSettings } from './workspace-settings.js'
import { assessReviewFriction, collectReviewDebt } from './reviewFriction.js'

// The pure verdict function is the single source of truth shared by the SPA (pre-warn) and the
// backend enforcement point, so its precedence + dedup + age semantics are pinned here.

const MINUTE = 60_000
const NOW = 10_000_000

function card(overrides: Partial<Notification>): Notification {
  return {
    id: `n-${Math.random()}`,
    type: 'merge_review',
    status: 'open',
    blockId: 'b1',
    executionId: null,
    title: 'Merge review',
    body: '',
    createdAt: NOW,
    resolvedAt: null,
    ...overrides,
  }
}

function settings(overrides: Partial<WorkspaceSettings>): WorkspaceSettings {
  return {
    reviewFrictionMode: 'warn',
    reviewFrictionWarnCount: 3,
    reviewFrictionBlockCount: null,
    reviewFrictionBlockStuckMinutes: null,
    ...overrides,
  } as WorkspaceSettings
}

describe('collectReviewDebt', () => {
  it('dedups per block, using the earliest open card as waitingSince, sorted oldest-first', () => {
    const debt = collectReviewDebt([
      card({ blockId: 'a', createdAt: NOW - 5 * MINUTE }),
      card({ blockId: 'a', type: 'followup_pending', createdAt: NOW - 8 * MINUTE }),
      card({ blockId: 'b', createdAt: NOW - 2 * MINUTE }),
    ])
    expect(debt).toEqual([
      { blockId: 'a', waitingSince: NOW - 8 * MINUTE },
      { blockId: 'b', waitingSince: NOW - 2 * MINUTE },
    ])
  })

  it('ignores non-open cards, block-less cards, and non-review-wait types', () => {
    const debt = collectReviewDebt([
      card({ blockId: 'a', status: 'acted' }),
      card({ blockId: 'b', status: 'dismissed' }),
      card({ blockId: null }),
      card({ blockId: 'c', type: 'ci_failed' }), // failure-remediation, excluded
      card({ blockId: 'd', type: 'test_failed' }), // excluded
      card({ blockId: 'e', type: 'release_regression' }), // excluded
      card({ blockId: 'f', type: 'pr_review_ready' }), // included
    ])
    expect(debt.map((d) => d.blockId)).toEqual(['f'])
  })
})

describe('assessReviewFriction', () => {
  it('mode off ⇒ ok regardless of debt', () => {
    const open = [card({ blockId: 'a' }), card({ blockId: 'b' }), card({ blockId: 'c' })]
    expect(assessReviewFriction(open, settings({ reviewFrictionMode: 'off' }), NOW)).toEqual({
      kind: 'ok',
    })
  })

  it('warn tier fires at (not below) the warn count', () => {
    const two = [card({ blockId: 'a' }), card({ blockId: 'b' })]
    expect(
      assessReviewFriction(two, settings({ reviewFrictionWarnCount: 3 }), NOW).kind,
    ).toBe('ok')

    const three = [...two, card({ blockId: 'c' })]
    const verdict = assessReviewFriction(three, settings({ reviewFrictionWarnCount: 3 }), NOW)
    expect(verdict.kind).toBe('warn')
    expect(verdict.kind === 'warn' && verdict.debt.length).toBe(3)
  })

  it('enforce: count block once debt reaches the block count', () => {
    const open = [card({ blockId: 'a' }), card({ blockId: 'b' })]
    const verdict = assessReviewFriction(
      open,
      settings({ reviewFrictionMode: 'enforce', reviewFrictionWarnCount: 1, reviewFrictionBlockCount: 2 }),
      NOW,
    )
    expect(verdict).toMatchObject({ kind: 'block', reason: 'count' })
  })

  it('enforce: the age (stuck) trigger wins over the count trigger', () => {
    const open = [
      card({ blockId: 'a', createdAt: NOW - 200 * MINUTE }), // stuck > 60 min
      card({ blockId: 'b', createdAt: NOW }),
    ]
    const verdict = assessReviewFriction(
      open,
      settings({
        reviewFrictionMode: 'enforce',
        reviewFrictionWarnCount: 1,
        reviewFrictionBlockCount: 2, // count would ALSO fire, but stuck takes precedence
        reviewFrictionBlockStuckMinutes: 60,
      }),
      NOW,
    )
    expect(verdict).toMatchObject({ kind: 'block', reason: 'stuck' })
  })

  it('enforce: null hard knobs fall through to the warn tier (never a block)', () => {
    const open = [card({ blockId: 'a' }), card({ blockId: 'b' }), card({ blockId: 'c' })]
    const verdict = assessReviewFriction(
      open,
      settings({
        reviewFrictionMode: 'enforce',
        reviewFrictionWarnCount: 3,
        reviewFrictionBlockCount: null,
        reviewFrictionBlockStuckMinutes: null,
      }),
      NOW,
    )
    expect(verdict.kind).toBe('warn')
  })

  it('warn mode never hard-blocks even with hard knobs configured', () => {
    const open = [card({ blockId: 'a', createdAt: NOW - 999 * MINUTE }), card({ blockId: 'b' })]
    const verdict = assessReviewFriction(
      open,
      settings({
        reviewFrictionMode: 'warn',
        reviewFrictionWarnCount: 2,
        reviewFrictionBlockCount: 1,
        reviewFrictionBlockStuckMinutes: 1,
      }),
      NOW,
    )
    expect(verdict.kind).toBe('warn')
  })

  it('empty debt ⇒ ok', () => {
    expect(assessReviewFriction([], settings({}), NOW)).toEqual({ kind: 'ok' })
  })
})
