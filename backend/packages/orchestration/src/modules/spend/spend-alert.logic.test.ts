import type { BudgetAlert } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { spendThresholdCardContent } from './spend-alert.logic.js'

const workspaceAlert: BudgetAlert = { tier: 'workspace', threshold: 0.8, projectedOverrun: false }
const accountAlert: BudgetAlert = { tier: 'account', threshold: null, projectedOverrun: true }

describe('spendThresholdCardContent', () => {
  it('names the crossed threshold and the budget it was crossed against', () => {
    const { title, body } = spendThresholdCardContent([workspaceAlert], {
      tier: 'workspace',
      costLimit: 100,
      currency: 'EUR',
      threshold: 0.8,
    })
    expect(title).toBe('Spend has passed 80% of the board budget')
    expect(body).toContain('100 EUR')
    expect(body).toContain('80%')
  })

  it('leads with the projection when nothing is crossed yet', () => {
    const { title, body } = spendThresholdCardContent([accountAlert], {
      tier: 'account',
      costLimit: 250,
      currency: 'USD',
      threshold: null,
    })
    expect(title).toBe('Spend is on pace to exceed the account budget')
    expect(body).toContain('projected to exceed it before the period ends')
  })

  it('says so when both tiers are firing, and stays quiet when only one is', () => {
    const subject = {
      tier: 'workspace' as const,
      costLimit: 100,
      currency: 'EUR',
      threshold: 0.8,
    }
    expect(spendThresholdCardContent([workspaceAlert, accountAlert], subject).body).toContain(
      'Both the board and its account budget are affected.',
    )
    expect(spendThresholdCardContent([workspaceAlert], subject).body).not.toContain('Both the')
  })

  it('renders identical copy for the same state, whatever the live spend is', () => {
    // The card's content is its dedup identity: the notification service re-delivers a card
    // whose title or body changed, and this condition holds for the rest of the period. Copy
    // that moved with the burn rate would re-toast the inbox every sweep for weeks.
    const subject = { tier: 'workspace' as const, costLimit: 100, currency: 'EUR', threshold: 0.8 }
    expect(spendThresholdCardContent([workspaceAlert], subject)).toEqual(
      spendThresholdCardContent([{ ...workspaceAlert }], { ...subject }),
    )
  })

  it('trims a pointless decimal tail off a round budget', () => {
    const round = spendThresholdCardContent([workspaceAlert], {
      tier: 'workspace',
      costLimit: 100,
      currency: 'EUR',
      threshold: 0.8,
    })
    expect(round.body).toContain('100 EUR')
    const fractional = spendThresholdCardContent([workspaceAlert], {
      tier: 'workspace',
      costLimit: 99.5,
      currency: 'EUR',
      threshold: 0.8,
    })
    expect(fractional.body).toContain('99.50 EUR')
  })
})
