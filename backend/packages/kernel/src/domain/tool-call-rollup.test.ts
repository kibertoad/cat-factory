import { describe, expect, it } from 'vitest'
import type { AgentToolCallSummary } from '../ports/agent-tool-calls.js'
import {
  foldToolCallTotals,
  foldToolCallsByAgentKind,
  foldToolCallsByTool,
  toolCallFailureRate,
  worstToolCallCell,
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

describe('worstToolCallCell', () => {
  it('names the (agentKind, tool) pair the failures concentrate on', () => {
    // The finest grain on purpose: one kind retrying one tool is a stuck loop, and both
    // breakdowns above have already folded that concentration away.
    const worst = worstToolCallCell([
      cell({ tool: 'bash', calls: 40, failures: 2 }),
      cell({ tool: 'edit', calls: 6, failures: 5 }),
      cell({ agentKind: 'ci-fixer', tool: 'edit', calls: 2, failures: 2 }),
    ])
    expect(worst).toMatchObject({ agentKind: 'coder', tool: 'edit', calls: 6, failures: 5 })
  })

  it('is null when nothing failed, rather than the busiest healthy cell', () => {
    expect(worstToolCallCell([cell({ calls: 40 })])).toBeNull()
    expect(worstToolCallCell([])).toBeNull()
  })
})

describe('toolCallFailureRate', () => {
  it('divides failures by calls', () => {
    expect(toolCallFailureRate({ calls: 8, failures: 2 })).toBe(0.25)
  })
})
