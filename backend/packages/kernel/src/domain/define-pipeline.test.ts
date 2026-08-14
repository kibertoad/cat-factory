import { describe, expect, it } from 'vitest'
import { definePipeline } from './define-pipeline.js'

// The lowering rules of the pipeline AUTHORING helper, now that it is a published seam rather
// than a private detail of the built-in catalog. `seed.test.ts` grades the catalog it produces;
// this grades the helper itself, which is what a DEPLOYMENT now calls with steps the catalog
// never uses.

describe('definePipeline', () => {
  const base = { id: 'pl_x', name: 'X', purpose: 'build' } as const

  it('emits ONLY agentKinds for a plain chain, byte-identical to the hand-authored form', () => {
    // The arrays are index-aligned with each other, so an all-default pipeline that emitted four
    // of them would persist a different row than the same pipeline written by hand, and every
    // comparison between a registered and a stored preset would report a difference that is not
    // one.
    expect(definePipeline({ ...base, steps: ['coder', 'merger'] })).toEqual({
      id: 'pl_x',
      name: 'X',
      purpose: 'build',
      agentKinds: ['coder', 'merger'],
    })
  })

  it('raises a human checkpoint for `gate: true` and for an APPROVER policy', () => {
    const pipeline = definePipeline({
      ...base,
      steps: [
        'coder',
        { kind: 'reviewer', gate: true },
        { kind: 'merger', gate: { minApprovals: 2 } },
      ],
    })
    expect(pipeline.gates).toEqual([false, true, true])
    // The approval half also lowers into the step's own options, so a configured gate needs no
    // second array.
    expect(pipeline.stepOptions?.[2]).toEqual({ gateConfig: { minApprovals: 2 } })
  })

  it('does NOT raise a checkpoint for a gate object that only configures the registered gate', () => {
    // `fields` parameterises the gate the step's KIND already runs (a `ci` step's attempt budget).
    // Lowering it into `gates[i]` would bolt a human approval pause onto a step whose author only
    // wanted three fixer rounds, and nothing downstream can tell an intended pause from an
    // inferred one.
    const pipeline = definePipeline({
      ...base,
      steps: [{ kind: 'ci', gate: { fields: { ciMaxAttempts: 3 } } }],
    })
    expect(pipeline.gates).toBeUndefined()
    expect(pipeline.stepOptions?.[0]).toEqual({ gateConfig: { fields: { ciMaxAttempts: 3 } } })
  })

  it('carries per-step options through and keeps them aligned with the disabled step', () => {
    const pipeline = definePipeline({
      ...base,
      steps: [
        {
          kind: 'media-generator',
          options: { binaryOutput: { storageServiceId: 'file-storage' } },
        },
        { kind: 'reviewer', enabled: false },
      ],
    })
    expect(pipeline.enabled).toEqual([true, false])
    expect(pipeline.stepOptions).toEqual([
      { binaryOutput: { storageServiceId: 'file-storage' } },
      null,
    ])
  })

  it('merges a step’s own options UNDER its gate config rather than dropping either', () => {
    const pipeline = definePipeline({
      ...base,
      steps: [
        {
          kind: 'tester-ui',
          gate: { minApprovals: 1 },
          options: { condition: { serviceScope: 'frontend' } },
        },
      ],
    })
    expect(pipeline.stepOptions?.[0]).toEqual({
      condition: { serviceScope: 'frontend' },
      gateConfig: { minApprovals: 1 },
    })
  })
})
