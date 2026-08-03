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
  return {
    stored: [],
    unknownServices: [],
    unknownGenerators: [],
    invalidEntries: 0,
    omitted: 0,
    ...patch,
  }
}

const artifact = (service: string, location: string) => ({ service, location })

describe('binaryOutputView', () => {
  // The regression this whole surface exists to prevent: five of the six outcomes are NOT
  // "an empty list", so each must resolve to its own state (and, through the shared key map,
  // its own copy). Collapsing any pair reports a run that stored nothing and a run whose
  // declaration was unreadable as the same thing.
  it('keeps the six outcomes apart', () => {
    const cases: [PipelineStep, string][] = [
      [
        step({ state: 'pending', stepOptions: { binaryOutput: { storageServiceId: 'files' } } }),
        'not-started',
      ],
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

  // A queued step has not had the chance to record anything, which `configured` ("running, or it
  // died") states as the opposite of what is true. It still renders — unlike a SKIPPED step it
  // has a story ahead of it, and where the artifacts will land is worth saying in advance.
  it('separates a step that has not started from one that started and recorded nothing', () => {
    const config = { binaryOutput: { storageServiceId: 'files' } }
    const queued = binaryOutputView(step({ state: 'pending', stepOptions: config }))
    expect(queued?.state).toBe('not-started')
    expect(queued?.target).toBe('files')
    // Nothing has gone wrong yet, so the section must not open itself expanded.
    expect(binaryOutputHasWarnings(queued!)).toBe(false)

    for (const state of ['working', 'waiting_decision', 'done'] as const)
      expect(binaryOutputView(step({ state, stepOptions: config }))?.state).toBe('configured')

    // A recorded claim still wins over either, exactly as it does for a skipped step.
    expect(
      binaryOutputView(
        step({
          state: 'pending',
          stepOptions: config,
          binaryOutputs: report({ undeclared: true }),
        }),
      )?.state,
    ).toBe('undeclared')
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
    expect(view?.unknownDeclaredServices).toEqual(['ghost'])
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

    expect(lost?.unknownDeclaredServices).toEqual([])

    const invented = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({ stored: [artifact('flies', 'a.png')], unknownServices: ['flies'] }),
      }),
    )
    expect(invented?.targetUnknown).toBe(false)
    expect(invented?.unknownDeclaredServices).toEqual(['flies'])
  })

  // Both at once is where sharing one field went wrong: the report's own `unknownServices` mixes
  // the lost target with the invented ids, so a surface reading it raw named ALL of them as "this
  // step's own storage service" and dropped the invented ones entirely. The two fields are
  // disjoint by construction, so no renderer can restate one as the other.
  it('keeps a lost target out of the invented-id list when both happened', () => {
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({
          stored: [artifact('files', 'a.png'), artifact('ghost', 'b.png')],
          unknownServices: ['files', 'ghost', 'phantom'],
        }),
      }),
    )
    expect(view?.targetUnknown).toBe(true)
    expect(view?.unknownDeclaredServices).toEqual(['ghost', 'phantom'])
    expect(view?.unknownDeclaredServices).not.toContain('files')
    expect(binaryOutputHasWarnings(view!)).toBe(true)
  })

  // A lost target with nothing else unknown is still a warning — it is the whole comparison the
  // surface exists to make, and the list it used to be counted in is now empty.
  it('treats a lost target alone as a warning', () => {
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files' } },
        binaryOutputs: report({ stored: [artifact('files', 'a.png')], unknownServices: ['files'] }),
      }),
    )
    expect(view?.unknownDeclaredServices).toEqual([])
    expect(binaryOutputHasWarnings(view!)).toBe(true)
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

describe('the generative half of the read model', () => {
  // The schema gained `unknownGenerators` and a per-artifact `generator`; both are RETAINED
  // claims, so a surface that drops them attributes an artifact to something nobody can look up
  // with nothing saying so — the exact silent loss `unknownDeclaredServices` exists to close.
  it('names integrations the deployment does not register, and badges their rows', () => {
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files', generatorIds: ['retro'] } },
        binaryOutputs: report({
          stored: [
            { ...artifact('files', 'a.png'), generator: 'retro' },
            { ...artifact('files', 'b.png'), generator: 'ghost' },
            artifact('files', 'c.png'),
          ],
          unknownGenerators: ['ghost'],
        }),
      }),
    )
    expect(view?.unknownDeclaredGenerators).toEqual(['ghost'])
    expect(view?.rows.map((r) => r.generatorUnknown)).toEqual([false, true, false])
    // An UNATTRIBUTED row is not an unknown one: generating without a registered integration is
    // legal (a model with native image output), so it must not be flagged as a bad id.
    expect(view?.rows[2]?.generator).toBeUndefined()
    expect(binaryOutputHasWarnings(view!)).toBe(true)
  })

  it('surfaces an UNCHECKED generative verdict, and does not let it read as a clean one', () => {
    // The settlement-side twin of the picker's `generators_unavailable`. An empty
    // `unknownDeclaredGenerators` normally means every claimed id checked out, so a reader
    // deciding whether these artifacts are real would take silence here as confirmation. The
    // flag has to reach both the line AND the collapsed summary's tone, or the one place it is
    // stated is behind a section that looks like it has nothing to say.
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files', generatorIds: ['retro'] } },
        binaryOutputs: report({
          stored: [{ ...artifact('files', 'a.png'), generator: 'retro' }],
          generatorsUnverified: true,
        }),
      }),
    )
    expect(view?.generatorsUnverified).toBe(true)
    expect(view?.unknownDeclaredGenerators).toEqual([])
    // The artifacts themselves survived the outage — that is the whole point of recording them.
    expect(view?.rows).toHaveLength(1)
    expect(binaryOutputHasWarnings(view!)).toBe(true)
  })

  it('reads a checked-and-clean report as clean, which is what makes the flag mean anything', () => {
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files', generatorIds: ['retro'] } },
        binaryOutputs: report({
          stored: [{ ...artifact('files', 'a.png'), generator: 'retro' }],
        }),
      }),
    )
    expect(view?.generatorsUnverified).toBe(false)
    expect(binaryOutputHasWarnings(view!)).toBe(false)
  })

  it('carries the step selection through, and treats empty as a real state', () => {
    const configured = binaryOutputView(
      step({
        state: 'pending',
        stepOptions: {
          binaryOutput: {
            storageServiceId: 'files',
            generatorIds: ['retro'],
            modalities: ['image'],
          },
        },
      }),
    )
    expect(configured?.generators).toEqual(['retro'])
    expect(configured?.modalities).toEqual(['image'])
    const bare = binaryOutputView(
      step({ state: 'pending', stepOptions: { binaryOutput: { storageServiceId: 'files' } } }),
    )
    expect(bare?.generators).toEqual([])
    expect(bare?.modalities).toEqual([])
  })
})

// The one judgement this surface can make that admission cannot: admission checked what the
// selected integrations CAN emit, this checks what the run actually came back with.
describe('the delivered-format check', () => {
  const required = (mediaTypes: string[], stored: { location: string; contentType?: string }[]) =>
    binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files', mediaTypes } },
        binaryOutputs: report({
          stored: stored.map((entry) => ({ service: 'files', ...entry })),
        }),
      }),
    )

  it('names a required format no declared artifact reports', () => {
    const view = required(
      ['model/gltf-binary', 'model/fbx'],
      [{ location: 'a.glb', contentType: 'model/gltf-binary' }],
    )
    expect(view?.undeliveredMediaTypes).toEqual(['model/fbx'])
    expect(binaryOutputHasWarnings(view!)).toBe(true)
  })

  it('reduces the agent’s own spelling before comparing, and only then', () => {
    // The requirement came through `mediaTypeSchema`; the artifact's content type is the model's
    // prose. Comparing them raw reports a format as undelivered while the file sits where it was
    // asked for.
    expect(
      required(['model/gltf-binary'], [{ location: 'a.glb', contentType: 'Model/GLTF-Binary' }])
        ?.undeliveredMediaTypes,
    ).toEqual([])
  })

  it('does not accept a near neighbour of the required format', () => {
    // The entire point of requiring a format rather than a content type: both of these are 3D.
    expect(
      required(['model/gltf-binary'], [{ location: 'a.fbx', contentType: 'model/fbx' }])
        ?.undeliveredMediaTypes,
    ).toEqual(['model/gltf-binary'])
  })

  it('counts an artifact that reports no content type as covering nothing', () => {
    expect(required(['model/gltf-binary'], [{ location: 'a.glb' }])?.undeliveredMediaTypes).toEqual(
      ['model/gltf-binary'],
    )
  })

  it('stays silent when there are no artifacts, because the state line already said so', () => {
    // "It did not deliver a GLB" on top of "it declared nothing" is one fact stated twice as if
    // it were two, and the second one adds nothing a reader can act on.
    const view = binaryOutputView(
      step({
        stepOptions: { binaryOutput: { storageServiceId: 'files', mediaTypes: ['model/obj'] } },
        binaryOutputs: report({ undeclared: true }),
      }),
    )
    expect(view?.mediaTypes).toEqual(['model/obj'])
    expect(view?.undeliveredMediaTypes).toEqual([])
  })
})

describe('binaryOutputPickIssues, generative half', () => {
  const catalog = [{ id: 'files', capabilities: ['asset-storage'] }]
  const generators = [
    { id: 'retro', modalities: ['image' as const] },
    { id: 'studio', modalities: ['audio' as const] },
  ]

  it('mirrors the admission refusal for an id this deployment does not register', () => {
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['retro', 'ghost'] },
      catalog,
      true,
      generators,
    )
    expect(pick.issues).toContain('unknown_generator')
    expect(pick.unknownGeneratorIds).toEqual(['ghost'])
  })

  it('names a declared content type nothing selected can produce', () => {
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['retro'], modalities: ['image', 'audio'] },
      catalog,
      true,
      generators,
    )
    expect(pick.issues).toContain('modality_uncovered')
    expect(pick.uncoveredModalities).toEqual(['audio'])
  })

  it('reports BOTH faults when an unknown id was the one covering a requirement', () => {
    // One edit should clear the step. Naming only the missing id would leave the user to
    // discover the uncovered requirement on the next round trip.
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['ghost'], modalities: ['audio'] },
      catalog,
      true,
      generators,
    )
    expect(pick.issues).toEqual(expect.arrayContaining(['unknown_generator', 'modality_uncovered']))
  })

  it('judges the generative half even when no storage target is picked yet', () => {
    // The early return for `not_selected` must not hide a second, independent fault.
    const pick = binaryOutputPickIssues(
      { storageServiceId: '', generatorIds: ['ghost'] },
      catalog,
      true,
      generators,
    )
    expect(pick.issues).toEqual(expect.arrayContaining(['not_selected', 'unknown_generator']))
  })

  it('is silent about a step that selects no integration at all', () => {
    const pick = binaryOutputPickIssues({ storageServiceId: 'files' }, catalog, true, generators)
    expect(pick.issues).toEqual([])
  })

  // The FORMAT half, mirroring kernel's `binaryFormatCoverage` — and its three outcomes, which
  // are what a second copy of the rule most easily loses.
  const meshy = {
    id: 'meshy',
    modalities: ['3d-model' as const],
    mediaTypes: ['model/gltf-binary'],
  }

  it('mirrors the refusal for a format no DECLARING integration emits', () => {
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['meshy'], mediaTypes: ['model/fbx'] },
      catalog,
      true,
      [meshy],
    )
    expect(pick.issues).toContain('media_type_uncovered')
    expect(pick.uncoveredMediaTypes).toEqual(['model/fbx'])
    expect(pick.unverifiableMediaTypes).toEqual([])
  })

  it('keeps an UNCHECKABLE format apart from a refused one, because the step still starts', () => {
    // `retro` declares no formats — "only my modality is known". Flagging this as a refusal would
    // send someone editing a selection the backend admits; saying nothing would present an
    // unchecked requirement as a checked one.
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['retro'], mediaTypes: ['image/webp'] },
      catalog,
      true,
      generators,
    )
    expect(pick.issues).toContain('media_type_unverifiable')
    expect(pick.issues).not.toContain('media_type_uncovered')
    expect(pick.unverifiableMediaTypes).toEqual(['image/webp'])
  })

  it('accepts a format the selection covers, however many other formats it emits', () => {
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['meshy'], mediaTypes: ['model/gltf-binary'] },
      catalog,
      true,
      [meshy],
    )
    expect(pick.issues).toEqual([])
  })

  it('reports an UNREADABLE set as an outage and makes no claim about the selection', () => {
    // The picker's half of the mothership-mode disposition. A failed read arrives as the same
    // empty list an unregistering deployment produces, so judging the selection against it would
    // tell someone their step names an integration nobody registered — about an id that is very
    // likely fine, and with the remedy pointing at the wrong repository.
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['retro'], modalities: ['audio'] },
      catalog,
      true,
      [],
      true,
    )
    expect(pick.issues).toEqual(['generators_unavailable'])
    expect(pick.unknownGeneratorIds).toEqual([])
    expect(pick.uncoveredModalities).toEqual([])
  })

  it('still judges an EMPTY set, which is a real answer about the deployment', () => {
    // The distinction the flag exists for: same empty list, opposite fact, opposite message.
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'files', generatorIds: ['retro'] },
      catalog,
      true,
      [],
      false,
    )
    expect(pick.issues).toContain('unknown_generator')
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

  // "Pick another" is not a remedy when there is nothing to pick: with no storage service in the
  // catalog at all, the per-selection judgements would print an instruction the surface cannot
  // carry out, beside the one that is actionable. The context half is a different selection,
  // judged on existence alone, so it stays.
  it('suppresses the per-selection storage judgements when the catalog has no storage service', () => {
    const contextOnly = [service('inventory', ['generation-context'])]
    const pick = binaryOutputPickIssues(
      { storageServiceId: 'gone', contextServiceIds: ['inventory', 'vanished'] },
      contextOnly,
      true,
    )
    expect(pick.issues).toContain('no_storage_service')
    expect(pick.issues).not.toContain('unknown_service')
    expect(pick.issues).not.toContain('not_storage_capable')
    expect(pick.issues).toContain('unknown_context_service')
    expect(pick.unknownContextIds).toEqual(['vanished'])
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
