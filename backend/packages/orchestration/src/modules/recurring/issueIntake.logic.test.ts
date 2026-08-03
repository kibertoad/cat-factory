import type { IssueIntakeConfig } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { assertValidIssueIntake, dispatchOf } from './issueIntake.logic.js'

function config(overrides: Partial<IssueIntakeConfig> = {}): IssueIntakeConfig {
  return {
    source: 'jira',
    board: { jiraProjectKey: 'ENG' },
    predicates: {},
    ...overrides,
  }
}

describe('dispatchOf', () => {
  it('defaults an absent dispatch to queue, so a pre-existing schedule is unchanged', () => {
    expect(dispatchOf(config())).toBe('queue')
  })

  it('reads an explicit mode verbatim', () => {
    expect(dispatchOf(config({ dispatch: 'queue' }))).toBe('queue')
    expect(dispatchOf(config({ dispatch: 'per-ticket' }))).toBe('per-ticket')
  })
})

describe('assertValidIssueIntake', () => {
  it('accepts a queue config on a bug-intake pipeline, cadence or not', () => {
    expect(() =>
      assertValidIssueIntake({ config: config(), onDemand: false, hasBugIntakeStep: true }),
    ).not.toThrow()
    expect(() =>
      assertValidIssueIntake({
        config: config({ dispatch: 'queue' }),
        onDemand: true,
        hasBugIntakeStep: true,
      }),
    ).not.toThrow()
  })

  it('accepts a per-ticket config on an on-demand schedule with no intake step', () => {
    expect(() =>
      assertValidIssueIntake({
        config: config({ dispatch: 'per-ticket' }),
        onDemand: true,
        hasBugIntakeStep: false,
      }),
    ).not.toThrow()
  })

  it('refuses a per-ticket config on a CADENCE schedule', () => {
    // A cadence tick carries no triggering ticket, so allowing this would silently fall back to
    // draining the queue: the `queue` behaviour under a config that says `per-ticket`.
    const call = () =>
      assertValidIssueIntake({
        config: config({ dispatch: 'per-ticket' }),
        onDemand: false,
        hasBugIntakeStep: false,
      })
    expect(call).toThrow(ValidationError)
    expect(call).toThrow(/on-demand/i)
  })

  it('refuses a per-ticket config on a bug-intake pipeline', () => {
    // The pushed ticket is already the work; an intake step would search the board and adopt a
    // DIFFERENT issue onto the block created for this one.
    const call = () =>
      assertValidIssueIntake({
        config: config({ dispatch: 'per-ticket' }),
        onDemand: true,
        hasBugIntakeStep: true,
      })
    expect(call).toThrow(ValidationError)
    expect(call).toThrow(/bug-intake/i)
  })

  it('carries a machine-readable reason on each refusal', () => {
    // The SPA maps `details.reason` to translated copy; a refusal that carried only prose would
    // reach a non-English user as English.
    const reasons = [
      { onDemand: false, hasBugIntakeStep: false, reason: 'per_ticket_requires_on_demand' },
      { onDemand: true, hasBugIntakeStep: true, reason: 'per_ticket_conflicts_with_bug_intake' },
    ]
    for (const { onDemand, hasBugIntakeStep, reason } of reasons) {
      try {
        assertValidIssueIntake({
          config: config({ dispatch: 'per-ticket' }),
          onDemand,
          hasBugIntakeStep,
        })
        expect.unreachable('should have refused')
      } catch (error) {
        expect((error as ValidationError).details).toMatchObject({ reason })
      }
    }
  })
})
