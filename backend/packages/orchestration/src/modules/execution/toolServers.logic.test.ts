import type { PipelineStep } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { applyObservedToolServers, coerceObservedToolServers } from './toolServers.logic.js'

// The OBSERVED half of a step's tool-server record. Every assertion here defends one of the two
// collapses that would make the surface lie: an unobserved run reading as one whose servers all
// failed, and a re-dispatch or a garbled producer erasing a record a container round wrote.

function stepWith(toolServers?: PipelineStep['toolServers']): PipelineStep {
  return {
    agentKind: 'coder',
    state: 'working',
    progress: 0,
    decision: null,
    ...(toolServers ? { toolServers } : {}),
  } as unknown as PipelineStep
}

const RECORD = {
  agentKind: 'coder',
  wired: [{ id: 'slack', label: 'Slack', transport: 'http' as const }],
  unavailable: [],
}

describe('applyObservedToolServers', () => {
  it('folds the CLI report onto a dispatch record, leaving the dispatch half untouched', () => {
    const step = stepWith(RECORD)
    expect(applyObservedToolServers(step, [{ id: 'slack', status: 'ready', toolCount: 4 }])).toBe(
      true,
    )
    expect(step.toolServers).toEqual({
      ...RECORD,
      observed: [{ id: 'slack', status: 'ready', toolCount: 4 }],
    })
  })

  it('refuses to CREATE a record from an observation alone', () => {
    // A record minted here would carry no `agentKind`, so its lists would be read under whatever
    // kind the step is named for — which is routinely not the kind that ran (a gate escalating to
    // `ci-fixer`, a tester handing off to `fixer`). An observation with no dispatch half beside it
    // is not the missing half of anything.
    const step = stepWith()
    expect(applyObservedToolServers(step, [{ id: 'slack', status: 'ready' }])).toBe(false)
    expect(step.toolServers).toBeUndefined()
  })

  it('is a no-op for an absent, unreadable or EMPTY report', () => {
    // The distinction the field rests on: absent means "not observed". Writing `[]` through would
    // turn that into "the CLI loaded nothing", which is the one reading that sends an operator
    // after a healthy server.
    for (const raw of [undefined, null, [], {}, 'nope', [{ status: 'ready' }], [{ id: '' }]]) {
      const step = stepWith(RECORD)
      expect(applyObservedToolServers(step, raw)).toBe(false)
      expect(step.toolServers).not.toHaveProperty('observed')
    }
  })

  it('does not churn when a later poll re-offers the same announcement', () => {
    // The CLI announces once and every later poll re-reports it, so an unchanged fold must not
    // persist + emit the run again on every tick of a long job.
    const step = stepWith(RECORD)
    const report = [{ id: 'slack', status: 'ready', toolCount: 4 }]
    expect(applyObservedToolServers(step, report)).toBe(true)
    expect(applyObservedToolServers(step, [{ id: 'slack', status: 'ready', toolCount: 4 }])).toBe(
      false,
    )
    // A genuinely different report still lands: a re-dispatch on the same step (a helper round)
    // re-resolves and re-announces, and its answer supersedes.
    expect(applyObservedToolServers(step, [{ id: 'slack', status: 'failed' }])).toBe(true)
    expect(step.toolServers?.observed).toEqual([{ id: 'slack', status: 'failed' }])
  })
})

describe('coerceObservedToolServers', () => {
  it('keeps a zero tool count and drops a nonsensical one', () => {
    // `0` is a server that connected and exposed nothing — the count a truthiness guard erases.
    expect(
      coerceObservedToolServers([
        { id: 'a', status: 'ready', toolCount: 0 },
        { id: 'b', status: 'ready', toolCount: -1 },
        { id: 'c', status: 'ready', toolCount: 'many' },
      ]),
    ).toEqual([
      { id: 'a', status: 'ready', toolCount: 0 },
      { id: 'b', status: 'ready' },
      { id: 'c', status: 'ready' },
    ])
  })

  it('narrows an unrecognised status to unknown rather than dropping the row', () => {
    expect(coerceObservedToolServers([{ id: 'a', status: 'reticulating' }])).toEqual([
      { id: 'a', status: 'unknown' },
    ])
  })

  it('drops one unusable row without discarding the rows beside it', () => {
    // The rows are independent facts about independent servers, so one this build cannot read is
    // no reason to lose what the CLI said about the others.
    expect(
      coerceObservedToolServers([
        null,
        { id: 'a', status: 'ready' },
        { status: 'ready' },
        { id: 'a', status: 'failed' },
        { id: 'b', status: 'failed' },
      ]),
    ).toEqual([
      { id: 'a', status: 'ready' },
      { id: 'b', status: 'failed' },
    ])
  })
})
