import { describe, expect, it } from 'vitest'
import type { BinaryOutputReport, PipelineStep } from '~/types/execution'
import {
  BINARY_OUTPUT_STATE_KEYS,
  binaryOutputHasWarnings,
  binaryOutputPickIssues,
  binaryOutputView,
} from './binaryOutput'

function step(patch: Partial<PipelineStep>): PipelineStep {
  return { agentKind: 'image-maker', state: 'done', ...patch } as PipelineStep
}

function report(patch: Partial<BinaryOutputReport> = {}): BinaryOutputReport {
  return { stored: [], unknownServices: [], invalidEntries: 0, omitted: 0, ...patch }
}

const artifact = (service: string, location: string) => ({ service, location })

describe('binaryOutputView', () => {
  // The regression this whole surface exists to prevent: four of the five outcomes are NOT
  // "an empty list", so each must resolve to its own state (and, through the shared key map,
  // its own copy). Collapsing any pair reports a run that stored nothing and a run whose
  // declaration was unreadable as the same thing.
  it('keeps the five outcomes apart', () => {
    const cases: [PipelineStep, string][] = [
      [step({ stepOptions: { binaryOutput: { storageServiceId: 'files' } } }), 'configured'],
      [step({ binaryOutputs: report({ undeclared: true }) }), 'undeclared'],
      [step({ binaryOutputs: report({ parseFailed: true }) }), 'parse-failed'],
      [step({ binaryOutputs: report() }), 'declared-none'],
      [step({ binaryOutputs: report({ stored: [artifact('files', 'a/b.png')] }) }), 'stored'],
    ]
    for (const [input, expected] of cases) expect(binaryOutputView(input)?.state).toBe(expected)
    // Every state has its own copy, so no two rows can read identically.
    const summaries = Object.values(BINARY_OUTPUT_STATE_KEYS).map((k) => k.summary)
    expect(new Set(summaries).size).toBe(summaries.length)
  })

  // Absence is the one thing that must NOT render: a step with neither a report nor a
  // selection had no binary-output story at all, which is every step of every stock pipeline.
  it('renders nothing for a step that was never briefed', () => {
    expect(binaryOutputView(step({}))).toBeNull()
    expect(binaryOutputView(null)).toBeNull()
  })

  // A gated-out step holds a selection it never ran with, so `configured` would tell a reader it
  // is still running or died mid-generation — both wrong, about a step already marked skipped.
  it('renders nothing for a step skipped by estimate gating', () => {
    expect(
      binaryOutputView(
        step({ skipped: true, stepOptions: { binaryOutput: { storageServiceId: 'files' } } }),
      ),
    ).toBeNull()
    // A recorded claim is never hidden, whatever else the step says about itself.
    expect(
      binaryOutputView(
        step({
          skipped: true,
          stepOptions: { binaryOutput: { storageServiceId: 'files' } },
          binaryOutputs: report({ stored: [artifact('files', 'a.png')] }),
        }),
      )?.state,
    ).toBe('stored')
  })

  // A parse failure implies an empty `stored`, so reading the list first would report it as
  // "the agent said it stored nothing" — the one misreading with a completely wrong remedy.
  it('reports an unreadable declaration as parse-failed, not as declared-none', () => {
    const view = binaryOutputView(step({ binaryOutputs: report({ parseFailed: true }) }))
    expect(view?.state).toBe('parse-failed')
    expect(view?.rows).toHaveLength(0)
  })

  it('names unknown services and keeps their rows', () => {
    const view = binaryOutputView(
      step({
        binaryOutputs: report({
          stored: [artifact('files', 'a.png'), artifact('ghost', 'b.png')],
          unknownServices: ['ghost'],
        }),
      }),
    )
    // The claim is recorded, not dropped — a reader judges it.
    expect(view?.rows).toHaveLength(2)
    expect(view?.unknownServices).toEqual(['ghost'])
    expect(view?.rows[1]?.unknown).toBe(true)
    expect(view?.rows[0]?.unknown).toBe(false)
  })

  // The join the report cannot make alone, and the question a human actually opens this for.
  it('marks a row stored through a service other than the configured target', () => {
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({ stored: [artifact('files', 'a.png'), artifact('audit', 'b.png')] }),
      }),
    )
    expect(view?.target).toBe('files')
    expect(view?.rows.map((r) => r.misdirected)).toEqual([false, true])
    expect(view?.misdirected).toBe(1)
  })

  // A step that never held a selection (a trait-carrying kind dispatched under an overriding
  // kind) has nothing to compare against — so nothing may be reported as having gone astray.
  it('marks nothing misdirected when the step carries no selection', () => {
    const view = binaryOutputView(
      step({ binaryOutputs: report({ stored: [artifact('audit', 'b.png')] }) }),
    )
    expect(view?.target).toBeNull()
    expect(view?.misdirected).toBe(0)
    expect(view?.rows[0]?.misdirected).toBe(false)
  })

  // "The catalog lost the step's own target" and "the agent named a service that never
  // existed" are the same `unknownServices` entry with opposite fixes.
  it('distinguishes a lost target from an invented service id', () => {
    const lost = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({ stored: [artifact('files', 'a.png')], unknownServices: ['files'] }),
      }),
    )
    expect(lost?.targetUnknown).toBe(true)

    const invented = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({ stored: [artifact('flies', 'a.png')], unknownServices: ['flies'] }),
      }),
    )
    expect(invented?.targetUnknown).toBe(false)
  })

  // Without the count, a capped list reads as the whole list and its tail as nonexistent.
  it('carries the counted losses through verbatim', () => {
    const view = binaryOutputView(
      step({
        binaryOutputs: report({ stored: [artifact('files', 'a')], invalidEntries: 2, omitted: 7 }),
      }),
    )
    expect(view?.invalidEntries).toBe(2)
    expect(view?.omitted).toBe(7)
    expect(binaryOutputHasWarnings(view!)).toBe(true)
  })

  it('treats a clean stored report as warning-free', () => {
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({ stored: [artifact('files', 'a.png')] }),
      }),
    )
    expect(binaryOutputHasWarnings(view!)).toBe(false)
  })
})

describe('binaryOutputPickIssues', () => {
  const service = (id: string, capabilities: string[]) => ({ id, capabilities })
  const catalog = [
    service('files', ['asset-storage']),
    service('inventory', ['generation-context']),
  ]

  it('accepts a selection that resolves against the catalog', () => {
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', contextServiceIds: ['inventory'] },
      catalog,
      true,
    )
    expect(pick.issues).toEqual([])
  })

  it('flags a step with no storage selection', () => {
    expect(binaryOutputPickIssues(undefined, catalog, true).issues).toContain('not_selected')
  })

  // The two refusals run admission raises, surfaced before the round trip rather than after it.
  it('mirrors the admission refusals for a stale or untagged storage id', () => {
    expect(binaryOutputPickIssues({ storageServiceId: 'gone' }, catalog, true).issues).toContain(
      'unknown_service',
    )
    expect(
      binaryOutputPickIssues({ storageServiceId: 'inventory' }, catalog, true).issues,
    ).toContain('not_storage_capable')
  })

  it('names every unresolved context id, not just the first', () => {
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', contextServiceIds: ['inventory', 'gone', 'also-gone'] },
      catalog,
      true,
    )
    expect(pick.issues).toContain('unknown_context_service')
    expect(pick.unknownContextIds).toEqual(['gone', 'also-gone'])
  })

  // An empty picker reads as "no services exist", which is a claim. Not-probed-yet, unreachable
  // and genuinely empty are three facts an empty array cannot tell apart.
  it('separates an unreachable and an unprobed catalog from an empty one', () => {
    expect(binaryOutputPickIssues(undefined, [], true).issues).toContain('no_storage_service')
    expect(binaryOutputPickIssues(undefined, [], false).issues).toEqual([
      'catalog_unavailable',
      'not_selected',
    ])
    // Before the probe lands there is nothing to say about the catalog — only about the step.
    expect(binaryOutputPickIssues(undefined, [], null).issues).toEqual(['not_selected'])
  })

  // An outage (or a load still in flight) changed nothing about the selection, so neither may
  // flag every step for re-pick.
  it('does not judge a selection against a catalog it has not read', () => {
    for (const available of [false, null] as const) {
      const pick = binaryOutputPickIssues(
        { storageServiceId: 'files', contextServiceIds: ['inventory'] },
        [],
        available,
      )
      expect(pick.issues).not.toContain('unknown_service')
      expect(pick.issues).not.toContain('unknown_context_service')
      expect(pick.unknownContextIds).toEqual([])
    }
  })
})
