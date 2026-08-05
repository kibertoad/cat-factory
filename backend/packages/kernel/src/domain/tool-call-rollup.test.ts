import { describe, expect, it } from 'vitest'
import type { AgentToolCallSummary } from '../ports/agent-tool-calls.js'
import {
  foldToolCallTotals,
  foldToolCallsByAgentKind,
  foldToolCallsByTool,
  toolCallFailureRate,
  worstToolRetryLoop,
} from './tool-call-rollup.js'

function cell(overrides: Partial<AgentToolCallSummary> = {}): AgentToolCallSummary {
  return { agentKind: 'coder', tool: 'bash', calls: 1, failures: 0, ...overrides }
}

describe('foldToolCallTotals', () => {
  it('sums calls and failures across every cell', () => {
    const totals = foldToolCallTotals([
      cell({ tool: 'edit', calls: 6, failures: 4 }),
      cell({ tool: 'bash', calls: 10, failures: 1 }),
      cell({ agentKind: 'ci-fixer', tool: 'edit', calls: 2, failures: 0 }),
    ])
    expect(totals).toEqual({ calls: 18, failures: 5 })
  })

  it('folds an empty run to zeroes with NO failure rate', () => {
    // Null, never 0: a run that called no tools has no failure rate, and a clean 0% would file
    // "nothing happened" beside "everything worked".
    const totals = foldToolCallTotals([])
    expect(totals).toEqual({ calls: 0, failures: 0 })
    expect(toolCallFailureRate(totals)).toBeNull()
  })
})

describe('foldToolCallsByTool / foldToolCallsByAgentKind', () => {
  const cells = [
    // The busiest tool, and almost entirely healthy.
    cell({ tool: 'bash', calls: 40, failures: 1 }),
    // The broken one, on a fraction of the calls.
    cell({ tool: 'edit', calls: 6, failures: 5 }),
    cell({ agentKind: 'ci-fixer', tool: 'edit', calls: 2, failures: 1 }),
  ]

  it('leads with the most-failed row, not the busiest one', () => {
    // The whole reason these are ordered at all: a reader is looking for what broke, and store
    // order (or call count) buries it behind whichever tool the agent used most.
    expect(foldToolCallsByTool(cells).map((row) => [row.tool, row.calls, row.failures])).toEqual([
      ['edit', 8, 6],
      ['bash', 40, 1],
    ])
    expect(
      foldToolCallsByAgentKind(cells).map((row) => [row.agentKind, row.calls, row.failures]),
    ).toEqual([
      ['coder', 46, 6],
      ['ci-fixer', 2, 1],
    ])
  })

  it('breaks a tie on the failure SHARE, then on the name, so the order is total', () => {
    // Two rows with one failure each: the one that failed on a tenth of its calls is the more
    // interesting of the two. An unstable order would read to a caller polling a finished run
    // as the run changing.
    const tied = [
      cell({ tool: 'bash', calls: 10, failures: 1 }),
      cell({ tool: 'edit', calls: 2, failures: 1 }),
      cell({ tool: 'grep', calls: 2, failures: 1 }),
    ]
    expect(foldToolCallsByTool(tied).map((row) => row.tool)).toEqual(['edit', 'grep', 'bash'])
  })

  it('totals identically to the run totals, on both axes', () => {
    // Both breakdowns are folds over ONE aggregate, so a table whose rows did not sum to the
    // totals printed above it is not a representable state.
    const totals = foldToolCallTotals(cells)
    for (const axis of [foldToolCallsByTool(cells), foldToolCallsByAgentKind(cells)]) {
      expect(axis.reduce((acc, row) => acc + row.calls, 0)).toBe(totals.calls)
      expect(axis.reduce((acc, row) => acc + row.failures, 0)).toBe(totals.failures)
    }
  })
})

describe('worstToolRetryLoop', () => {
  it('names the (agentKind, tool) pair the failures concentrate on', () => {
    // The finest grain on purpose: one kind retrying one tool is a stuck loop, and both
    // breakdowns above have already folded that concentration away.
    const worst = worstToolRetryLoop([
      cell({ tool: 'bash', calls: 40, failures: 2 }),
      cell({ tool: 'edit', calls: 6, failures: 5 }),
      cell({ agentKind: 'ci-fixer', tool: 'edit', calls: 2, failures: 2 }),
    ])
    expect(worst).toMatchObject({ agentKind: 'coder', tool: 'edit', calls: 6, failures: 5 })
  })

  it('finds a loop sitting BEHIND a busier cell with more raw failures', () => {
    // The regression that motivated filtering before ranking. `bash` outranks the wedged cell on
    // failure COUNT while being 94% healthy, so testing the top-ranked cell alone reports no loop
    // on a run that is textbook stuck, the exact shape of a coder running tests that fail beside
    // a fixer that cannot apply its patch.
    const worst = worstToolRetryLoop([
      cell({ tool: 'bash', calls: 100, failures: 6 }),
      cell({ agentKind: 'ci-fixer', tool: 'apply_patch', calls: 5, failures: 5 }),
    ])
    expect(worst).toMatchObject({ agentKind: 'ci-fixer', tool: 'apply_patch' })
  })

  it('ranks among the QUALIFYING cells when several are loops', () => {
    const worst = worstToolRetryLoop([
      cell({ tool: 'edit', calls: 12, failures: 9 }),
      cell({ agentKind: 'ci-fixer', tool: 'apply_patch', calls: 6, failures: 6 }),
    ])
    expect(worst).toMatchObject({ tool: 'edit', failures: 9 })
  })

  it('holds BOTH conditions, so neither a lone failure nor a busy healthy cell is a loop', () => {
    // Under the count floor, however total the failure…
    expect(worstToolRetryLoop([cell({ calls: 4, failures: 4 })])).toBeNull()
    // …and over it, but nowhere near mostly-failing: a thorough agent, not a stuck one.
    expect(worstToolRetryLoop([cell({ calls: 400, failures: 20 })])).toBeNull()
    // The boundary is inclusive on both, so the first genuinely-stuck cell is named.
    expect(worstToolRetryLoop([cell({ calls: 10, failures: 5 })])).toMatchObject({ failures: 5 })
  })

  it('is null when nothing failed, rather than the busiest healthy cell', () => {
    expect(worstToolRetryLoop([cell({ calls: 40 })])).toBeNull()
    expect(worstToolRetryLoop([])).toBeNull()
  })
})

describe('toolCallFailureRate', () => {
  it('divides failures by calls', () => {
    expect(toolCallFailureRate({ calls: 8, failures: 2 })).toBe(0.25)
  })
})
