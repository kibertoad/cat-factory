import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { seedPipelines } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  canParkOnHuman,
  HUMAN_WAIT_GATE_KINDS,
  INPUT_GATE_PARK_SURFACE,
  isHeadlessInlinePipeline,
  isInlineOnlyPipeline,
  PARKING_INLINE_KINDS,
  parkingRefusalMessage,
  parkSurfacesOf,
  PUBLIC_JOB_CANCEL_PATH,
  PUBLIC_TASK_STOP_PATH,
  publicRunParkSurfaces,
  PUBLICLY_ANSWERABLE_PARK_SURFACES,
} from './publicApiAdmission.js'

// The public-API admission policy. Two INDEPENDENT halves, and the whole point of slice 1 is that
// they stopped being one flat refusal:
//
//  - inline-only is ABSOLUTE (no scope lifts it) — an external key must never trigger container
//    work or a GitHub write through the jobs surface;
//  - parking is a SCOPE question — a pipeline that can park needs a caller able to answer, which
//    is exactly what a `decide` key asserts.
//
// The parking half enumerates THREE mechanisms (approval-gate flag, inline review/brainstorm kind,
// unbounded human-wait gate). The third was missed on the first pass and is asserted against the
// real seed catalog below, because a synthetic step chain cannot show that the gap was reachable
// through a pipeline the product actually ships.
//
// These live here rather than in the cross-runtime conformance suite because the built-in public
// pipeline is read-only: there is no way to construct a public-and-parking pipeline over HTTP, so
// the cases that matter most would be untestable through the wire. The logic is pure and lives in
// the shared controller layer, so it cannot drift between facades either way.

const registry = defaultAgentKindRegistry()

describe('public-API admission', () => {
  describe('isInlineOnlyPipeline', () => {
    it('accepts a chain of inline engine kinds', () => {
      expect(
        isInlineOnlyPipeline({ agentKinds: ['initiative-breakdown', 'task-estimator'] }, registry),
      ).toBe(true)
    })

    it('rejects a chain containing a container/repo step', () => {
      // The non-negotiable half: `coder` clones and pushes, so no key of any scope may launch it
      // through the jobs surface.
      expect(isInlineOnlyPipeline({ agentKinds: ['coder'] }, registry)).toBe(false)
      expect(
        isInlineOnlyPipeline({ agentKinds: ['initiative-breakdown', 'coder'] }, registry),
      ).toBe(false)
    })

    it('ignores DISABLED steps, which never run', () => {
      // A disabled step stays in the chain for editing but is skipped at run time, so it must not
      // veto admission — otherwise a pipeline whose container step was turned off would be
      // permanently unlaunchable for no reason.
      expect(
        isInlineOnlyPipeline(
          { agentKinds: ['initiative-breakdown', 'coder'], enabled: [true, false] },
          registry,
        ),
      ).toBe(true)
    })

    it('rejects a pipeline with no enabled steps at all', () => {
      expect(isInlineOnlyPipeline({ agentKinds: [] }, registry)).toBe(false)
      expect(
        isInlineOnlyPipeline({ agentKinds: ['initiative-breakdown'], enabled: [false] }, registry),
      ).toBe(false)
    })

    it('rejects an unknown kind rather than assuming it is harmless', () => {
      expect(isInlineOnlyPipeline({ agentKinds: ['not-a-real-kind'] }, registry)).toBe(false)
    })
  })

  describe('canParkOnHuman', () => {
    it('detects each inline-and-parking kind', () => {
      // All four set the run `blocked` awaiting a human. Missing any one of them would silently
      // admit a hanging pipeline for a plain `write` key — the exact regression the set guards.
      for (const kind of [
        'requirements-review',
        'clarity-review',
        'requirements-brainstorm',
        'architecture-brainstorm',
      ]) {
        expect(canParkOnHuman({ agentKinds: [kind] }), kind).toBe(true)
      }
    })

    it('detects an approval gate on an enabled step', () => {
      // A gate parks the run just as surely as a review kind does, on an otherwise ordinary step.
      expect(canParkOnHuman({ agentKinds: ['initiative-breakdown'], gates: [true] })).toBe(true)
    })

    it('ignores a gate on a DISABLED step (index-aligned with the original chain)', () => {
      // `gates` is parallel to the ORIGINAL `agentKinds`, so the alignment has to survive
      // filtering — reading the gate array by the FILTERED index would look at the wrong step.
      expect(
        canParkOnHuman({
          agentKinds: ['initiative-breakdown', 'task-estimator'],
          enabled: [true, false],
          gates: [false, true],
        }),
      ).toBe(false)
      expect(
        canParkOnHuman({
          agentKinds: ['initiative-breakdown', 'task-estimator'],
          enabled: [false, true],
          gates: [true, false],
        }),
      ).toBe(false)
    })

    it('ignores a parking kind on a disabled step', () => {
      expect(
        canParkOnHuman({
          agentKinds: ['initiative-breakdown', 'requirements-review'],
          enabled: [true, false],
        }),
      ).toBe(false)
    })

    it('is false for an ordinary non-parking chain', () => {
      expect(canParkOnHuman({ agentKinds: ['initiative-breakdown'] })).toBe(false)
    })

    it('sees a human-wait GATE kind, which carries no approval-gate flag of its own', () => {
      // The third park mechanism, and the one that shipped unseen. `human-review` is a polling gate
      // whose poll never times out (`pollExhaustion: 'rearm'`) because it is waiting on a person on
      // the PR, so it parks the run just as surely as a review kind. It rides the step chain as an
      // ordinary kind with `gates[i]` false, so neither of the other two checks could find it.
      expect(canParkOnHuman({ agentKinds: ['coder', 'human-review', 'merger'] })).toBe(true)
    })

    it('ignores a human-wait gate on a disabled step', () => {
      expect(
        canParkOnHuman({ agentKinds: ['coder', 'human-review'], enabled: [true, false] }),
      ).toBe(false)
    })

    it('treats the shipped Adaptive build preset as parking', () => {
      // The regression this closes, stated against the real catalog rather than a synthetic chain:
      // `pl_full` is the flagship board preset and carries a risk-gated `human-review`. While that
      // kind was invisible to the rule, a plain `write` key could start it and have the run park
      // indefinitely on the ONE surface `/api/v1/runs/:runId/decisions` cannot answer at all.
      //
      // Read from the seed catalog, so re-shaping the preset re-runs the question instead of
      // leaving a hand-copied step list asserting something the product no longer does.
      const full = seedPipelines().find((p) => p.id === 'pl_full')
      expect(full, 'pl_full must exist in the built-in catalog').toBeTruthy()
      expect(full!.agentKinds).toContain('human-review')
      expect(canParkOnHuman(full!)).toBe(true)
      expect(parkSurfacesOf(full!)).toContain('human-review')
    })

    it('leaves the unconditional build presets startable by a plain write key', () => {
      // The other side of the same change: widening the enumeration must not sweep up the presets
      // whose whole selling point is that they never pause. If this flips, every `write`-key
      // integration driving ordinary board work breaks at once.
      for (const id of ['pl_build', 'pl_simple']) {
        const pipeline = seedPipelines().find((p) => p.id === id)
        expect(pipeline, `${id} must exist in the built-in catalog`).toBeTruthy()
        expect(canParkOnHuman(pipeline!), id).toBe(false)
      }
    })
  })

  describe('parkSurfacesOf', () => {
    it('names the gate and the kind separately when a step carries both', () => {
      expect(parkSurfacesOf({ agentKinds: ['requirements-review'], gates: [true] })).toEqual([
        'approval-gate',
        'requirements-review',
      ])
    })

    it('dedupes a surface reached by several steps', () => {
      // Two gated steps are ONE thing to tell the caller about, not two.
      expect(
        parkSurfacesOf({
          agentKinds: ['initiative-breakdown', 'task-estimator'],
          gates: [true, true],
        }),
      ).toEqual(['approval-gate'])
    })

    it('is empty for a chain that cannot park', () => {
      expect(parkSurfacesOf({ agentKinds: ['initiative-breakdown'] })).toEqual([])
    })
  })

  describe('parkingRefusalMessage', () => {
    it('promises an answer path ONLY for surfaces the decision surface really serves', () => {
      // The defect this replaced: the old fixed sentence named all four park types and told the
      // operator a `decide` key answers them through /api/v1/runs/:runId/decisions. Three of them
      // are answerable only in the app, so the advice bought a wider-scoped key and a run whose
      // only exit is cancel.
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['clarity-review'] }, { inputGateBlocks: false }),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain('clarity-review')
      expect(message).not.toContain('/api/v1/runs/:runId/decisions')
      expect(message).toContain('POST /api/v1/jobs/:id/cancel')
    })

    it('names the exit route of the surface being refused, not always the jobs cancel', () => {
      // The board-task start applies the same rule, but its abandoned park is freed with `stop`,
      // not with the jobs cancel, so a refusal steering a task caller at `/jobs/:id/cancel` would
      // name a route that 404s for the run it is about. `cancelPath` is required rather than
      // defaulted precisely so a third start surface cannot inherit either of these by accident.
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['clarity-review'] }, { inputGateBlocks: false }),
        { cancelPath: PUBLIC_TASK_STOP_PATH },
      )
      expect(message).toContain('POST /api/v1/tasks/:taskId/stop')
      expect(message).not.toContain('/jobs/:id/cancel')
    })

    it('names both halves when a pipeline mixes answerable and unanswerable parks', () => {
      const message = parkingRefusalMessage(
        publicRunParkSurfaces(
          { agentKinds: ['requirements-review', 'initiative-breakdown'], gates: [false, true] },
          { inputGateBlocks: false },
        ),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain(
        "Start it with a 'decide'-scope key, which can answer requirements-review through /api/v1/runs/:runId/decisions.",
      )
      expect(message).toContain('cannot answer approval-gate yet')
    })

    it('mentions no cancel-only caveat when every park is answerable', () => {
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['requirements-review'] }, { inputGateBlocks: false }),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain('/api/v1/runs/:runId/decisions')
      expect(message).not.toContain('cancel')
    })

    it('never claims an answer path for a surface outside the answerable set', () => {
      // The drift guard. Landing a slice of docs/initiatives/public-api-additions.md means adding
      // a member to PUBLICLY_ANSWERABLE_PARK_SURFACES; until then no message may advertise one.
      // Covers the human-wait gates too, so a future slice that makes one answerable has to move it
      // into the answerable set rather than leaving the message silently wrong.
      for (const kind of [...PARKING_INLINE_KINDS, ...HUMAN_WAIT_GATE_KINDS]) {
        const message = parkingRefusalMessage(
          publicRunParkSurfaces({ agentKinds: [kind] }, { inputGateBlocks: false }),
          { cancelPath: PUBLIC_JOB_CANCEL_PATH },
        )
        expect(message.includes('/api/v1/runs/:runId/decisions'), kind).toBe(
          PUBLICLY_ANSWERABLE_PARK_SURFACES.has(kind),
        )
      }
    })
  })

  describe('isHeadlessInlinePipeline (the `headlessStartable` discovery flag)', () => {
    it('is true only when the pipeline is both inline-only and non-parking', () => {
      // This is what a `write`-scope caller can drive end to end with no follow-up. A parking
      // pipeline is still ADMISSIBLE for a `decide` key — it just is not headless-startable.
      expect(isHeadlessInlinePipeline({ agentKinds: ['initiative-breakdown'] }, registry)).toBe(
        true,
      )
      expect(isHeadlessInlinePipeline({ agentKinds: ['requirements-review'] }, registry)).toBe(
        false,
      )
      expect(
        isHeadlessInlinePipeline({ agentKinds: ['initiative-breakdown'], gates: [true] }, registry),
      ).toBe(false)
      expect(isHeadlessInlinePipeline({ agentKinds: ['coder'] }, registry)).toBe(false)
    })
  })
})

describe('publicRunParkSurfaces', () => {
  // The regression this pins: the PRE-DISPATCH INPUT GATE parks on the shape of the TASK, so
  // `parkSurfacesOf` (which reads the step chain) cannot see it. A `write` key could start a
  // title-only task under a pipeline that parks nowhere and get a run that stopped before its
  // first dispatch with nothing able to answer it and only cancel as a way out.
  const inlineOnly = { agentKinds: ['task-estimator'] }

  it('reports no park for a non-parking pipeline whose task is fine', () => {
    expect(publicRunParkSurfaces(inlineOnly, { inputGateBlocks: false })).toEqual([])
  })

  it('reports the gate for a non-parking pipeline whose TASK would park the run', () => {
    expect(publicRunParkSurfaces(inlineOnly, { inputGateBlocks: true })).toEqual([
      INPUT_GATE_PARK_SURFACE,
    ])
  })

  it('lists the gate FIRST, since it parks before any step of the pipeline runs', () => {
    const surfaces = publicRunParkSurfaces(
      { agentKinds: ['requirements-review'] },
      { inputGateBlocks: true },
    )
    expect(surfaces[0]).toBe(INPUT_GATE_PARK_SURFACE)
    expect(surfaces).toContain('requirements-review')
  })

  it('is answerable, so the refusal steers at the decision surface rather than at cancel', () => {
    // The gate has a public resolve route (`POST /api/v1/runs/:runId/decisions/input-gate/resolve`),
    // so unlike the app-only parks it must NOT be described as cancel-only.
    expect(PUBLICLY_ANSWERABLE_PARK_SURFACES.has(INPUT_GATE_PARK_SURFACE)).toBe(true)
    const message = parkingRefusalMessage(
      publicRunParkSurfaces(inlineOnly, { inputGateBlocks: true }),
      { cancelPath: PUBLIC_JOB_CANCEL_PATH },
    )
    expect(message).toContain(INPUT_GATE_PARK_SURFACE)
    expect(message).toContain('/api/v1/runs/:runId/decisions')
    expect(message).not.toContain('cannot answer')
  })
})
