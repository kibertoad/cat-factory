import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { GateDefinition, GatePollExhaustion, GateRegistry } from '@cat-factory/kernel'
import { defaultGateRegistry, seedPipelines } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  type AdmissionRegistries,
  BINARY_CANDIDATE_PARK_SURFACE,
  canParkOnHuman,
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
// The parking half enumerates FIVE mechanisms (approval-gate flag, inline review/brainstorm kind,
// unbounded human-wait gate, interview-gate trait, binary-candidate comparison). The third and the
// fifth were both missed on a first pass and are asserted against the real seed catalog below,
// because a synthetic step chain cannot show that the gap was reachable through a pipeline the
// product actually ships.
//
// These live here rather than in the cross-runtime conformance suite because the built-in public
// pipeline is read-only: there is no way to construct a public-and-parking pipeline over HTTP, so
// the cases that matter most would be untestable through the wire. The logic is pure and lives in
// the shared controller layer, so it cannot drift between facades either way.

const registry = defaultAgentKindRegistry()

/**
 * A gate registry declaring `human-review` a human-wait gate, which is what `@cat-factory/gates`
 * registers it as.
 *
 * Registered HERE rather than imported, because this package cannot see the gate suite (nothing
 * outside a facade depends on it), and, more to the point, because what these cases are about is
 * the MECHANISM: a gate is a human park iff its own registration says `pollExhaustion: 'rearm'`,
 * whoever registered it. `@cat-factory/gates` owns the other half (that `human-review` is declared
 * that way) and asserts it there. That pairing replaced a hand-kept constant in
 * `@cat-factory/contracts` plus a drift guard, which could only ever name the SHIPPED wait gates
 * and left a deployment's own invisible to admission.
 */
function gatesDeclaring(kinds: Record<string, GatePollExhaustion>): GateRegistry {
  const gates = defaultGateRegistry()
  for (const [kind, pollExhaustion] of Object.entries(kinds)) {
    // The FACTORY is never invoked by anything under test here: admission reads the registration,
    // which is the change these cases exist to pin. A factory that throws would state that, but it
    // would also make the stub a trap for the next case that legitimately builds one.
    gates.register(kind, () => ({ kind }) as unknown as GateDefinition, { pollExhaustion })
  }
  return gates
}

/** The default pairing every case below reasons against: built-in kinds + the shipped wait gate. */
const registries: AdmissionRegistries = {
  agentKinds: registry,
  gates: gatesDeclaring({ 'human-review': 'rearm', ci: 'fail', 'post-release-health': 'pass' }),
}

/** The same pairing with a different agent-kind registry (the custom-interviewer cases). */
const withAgentKinds = (agentKinds: AgentKindRegistry): AdmissionRegistries => ({
  ...registries,
  agentKinds,
})

describe('public-API admission: the ABSOLUTE half', () => {
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
})

// The SECOND half, split out because the first one grew past the function-lines budget and these
// two were never one subject: inline-only is absolute and reads the step kinds, while everything
// below is the SCOPE question and reads the park mechanisms. The file header states that seam;
// this is it, drawn where the header already drew it.
describe('public-API admission: the SCOPE half (parking)', () => {
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
        expect(canParkOnHuman({ agentKinds: [kind] }, registries), kind).toBe(true)
      }
    })

    it('detects an approval gate on an enabled step', () => {
      // A gate parks the run just as surely as a review kind does, on an otherwise ordinary step.
      expect(
        canParkOnHuman({ agentKinds: ['initiative-breakdown'], gates: [true] }, registries),
      ).toBe(true)
    })

    it('ignores a gate on a DISABLED step (index-aligned with the original chain)', () => {
      // `gates` is parallel to the ORIGINAL `agentKinds`, so the alignment has to survive
      // filtering — reading the gate array by the FILTERED index would look at the wrong step.
      expect(
        canParkOnHuman(
          {
            agentKinds: ['initiative-breakdown', 'task-estimator'],
            enabled: [true, false],
            gates: [false, true],
          },
          registries,
        ),
      ).toBe(false)
      expect(
        canParkOnHuman(
          {
            agentKinds: ['initiative-breakdown', 'task-estimator'],
            enabled: [false, true],
            gates: [true, false],
          },
          registries,
        ),
      ).toBe(false)
    })

    it('detects a binary-candidate comparison, which lives in the step OPTIONS', () => {
      // The fifth mechanism, and the first that is invisible from the step chain: the same kind
      // with and without `comparison` is the same entry in `agentKinds`, and only one of them
      // stops. `pl_media` is the first shipped preset to set it, so until it did, a plain `write`
      // key could start a run that parked on a surface `/api/v1` cannot answer.
      expect(
        canParkOnHuman(
          {
            agentKinds: ['media-generator'],
            stepOptions: [{ binaryOutput: { comparison: { perGenerator: 2 } } }],
          },
          registries,
        ),
      ).toBe(true)
    })

    it('does not park on a binary-output step that was never asked to compare', () => {
      // Storing what it generated is not a decision anyone has to make. Treating the whole
      // `binaryOutput` selection as a park would refuse every generating pipeline to a `write`
      // key, including the ones that never stop.
      //
      // The literal carries only `binaryOutput` and nothing inside it, because that is the whole
      // of what `AdmissiblePipelineShape` declares: the narrowing is the point, and a real
      // `StepOptions[]` (which carries a storage id, generator ids, modalities and the rest)
      // still assigns to it. `pl_media` read straight from the seed catalog is the case that
      // proves that half.
      expect(
        canParkOnHuman(
          { agentKinds: ['media-generator'], stepOptions: [{ binaryOutput: {} }] },
          registries,
        ),
      ).toBe(false)
    })

    it('ignores a comparison on a DISABLED step (options are index-aligned too)', () => {
      // Same alignment rule the gate array follows: `stepOptions` is parallel to the ORIGINAL
      // chain, so reading it by the filtered index would look at another step's configuration.
      expect(
        canParkOnHuman(
          {
            agentKinds: ['initiative-breakdown', 'media-generator'],
            enabled: [true, false],
            stepOptions: [null, { binaryOutput: { comparison: { perGenerator: 2 } } }],
          },
          registries,
        ),
      ).toBe(false)
    })

    it('ignores a parking kind on a disabled step', () => {
      expect(
        canParkOnHuman(
          {
            agentKinds: ['initiative-breakdown', 'requirements-review'],
            enabled: [true, false],
          },
          registries,
        ),
      ).toBe(false)
    })

    it('is false for an ordinary non-parking chain', () => {
      expect(canParkOnHuman({ agentKinds: ['initiative-breakdown'] }, registries)).toBe(false)
    })

    it('sees a human-wait GATE kind, which carries no approval-gate flag of its own', () => {
      // The third park mechanism, and the one that shipped unseen. `human-review` is a polling gate
      // whose poll never times out (`pollExhaustion: 'rearm'`) because it is waiting on a person on
      // the PR, so it parks the run just as surely as a review kind. It rides the step chain as an
      // ordinary kind with `gates[i]` false, so neither of the other two checks could find it.
      expect(canParkOnHuman({ agentKinds: ['coder', 'human-review', 'merger'] }, registries)).toBe(
        true,
      )
    })

    it('sees a wait gate the DEPLOYMENT registered, not just the shipped one', () => {
      // The gap this closed. A gate's `pollExhaustion` used to be readable only off the object its
      // factory builds from an engine context, so admission read a hand-kept constant naming the
      // SHIPPED wait gates instead, and a deployment that registered its own unbounded-wait gate
      // through the public `GateRegistry` seam was invisible to it. A plain `write` key could start
      // such a pipeline and have the run park forever with nothing here able to name the surface.
      const withOwnGate: AdmissionRegistries = {
        agentKinds: registry,
        gates: gatesDeclaring({ 'acme-legal-hold': 'rearm' }),
      }
      expect(canParkOnHuman({ agentKinds: ['coder', 'acme-legal-hold'] }, withOwnGate)).toBe(true)
      expect(parkSurfacesOf({ agentKinds: ['acme-legal-hold'] }, withOwnGate)).toEqual([
        'acme-legal-hold',
      ])
    })

    it('leaves a BOUNDED gate out, however the deployment declared it', () => {
      // The other direction, and it fails differently: a gate wrongly counted refuses a `write` key
      // a start it should have been allowed. `ci` loops through a fixer and settles itself, and a
      // registration that declares nothing at all means `fail`, i.e. bounded, never "assume a person".
      const bounded: AdmissionRegistries = {
        agentKinds: registry,
        gates: gatesDeclaring({ ci: 'fail', 'acme-watch': 'pass' }),
      }
      expect(parkSurfacesOf({ agentKinds: ['ci', 'acme-watch'] }, bounded)).toEqual([])
      const undeclared = defaultGateRegistry()
      undeclared.register('acme-quiet', () => ({ kind: 'acme-quiet' }) as unknown as GateDefinition)
      expect(
        parkSurfacesOf({ agentKinds: ['acme-quiet'] }, { agentKinds: registry, gates: undeclared }),
      ).toEqual([])
    })

    it('ignores a human-wait gate on a disabled step', () => {
      expect(
        canParkOnHuman(
          { agentKinds: ['coder', 'human-review'], enabled: [true, false] },
          registries,
        ),
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
      expect(canParkOnHuman(full!, registries)).toBe(true)
      expect(parkSurfacesOf(full!, registries)).toContain('human-review')
    })

    it('sees an INTERVIEW gate, whose kind is neither a review nor a polling gate', () => {
      // The fourth mechanism. An interviewer parks through its own controller rather than through
      // a `gate` flag, and it is an INLINE step, so before this it was not merely missed: it was
      // missed in the direction that lies: a chain of interview steps satisfies inline-only, so it
      // was advertised as `headlessStartable` while every run of it stopped on the first batch of
      // questions.
      expect(canParkOnHuman({ agentKinds: ['doc-interviewer'] }, registries)).toBe(true)
      expect(parkSurfacesOf({ agentKinds: ['initiative-interviewer'] }, registries)).toEqual([
        'interview',
      ])
      expect(isHeadlessInlinePipeline({ agentKinds: ['doc-interviewer'] }, registries)).toBe(false)
    })

    it('follows the TRAIT, so a deployment’s own interviewer is seen with no edit here', () => {
      // Declared at REGISTRATION, so a custom interviewer reaches this rule the moment it is
      // registered. That was once what made case 4 different from the wait-gate case beside it,
      // which could only see the SHIPPED gates; a gate now declares its `pollExhaustion` at
      // registration too, so both derive from something a deployment's own registrations flow
      // through. Asserted on a registry the test registers into, so the claim is about the
      // mechanism rather than about the built-ins.
      const custom = defaultAgentKindRegistry()
      custom.register({
        kind: 'org-interviewer',
        systemPrompt: 'x',
        agent: { surface: 'inline' },
        traits: ['interview-gate'],
      })
      expect(canParkOnHuman({ agentKinds: ['org-interviewer'] }, withAgentKinds(custom))).toBe(true)
      // …and unregistered, the same chain is just an unknown kind that parks nowhere.
      expect(canParkOnHuman({ agentKinds: ['org-interviewer'] }, registries)).toBe(false)
    })

    it('does NOT count the follow-up companion, which every Coder step carries', () => {
      // A deliberate omission, not a miss, and the one place the rule knowingly admits a park a
      // `write` key cannot answer. The companion is seeded on every Coder step unless a pipeline
      // turns it off, so counting it would make `decide` mandatory for all board work that builds
      // anything; see `parkSurfacesOf`. The park is answerable over `/api/v1` now, which is what
      // makes leaving it out recoverable rather than a dead end.
      expect(parkSurfacesOf({ agentKinds: ['coder'] }, registries)).toEqual([])
    })

    it('treats the shipped Media preset as parking, on its step OPTIONS alone', () => {
      // The fifth mechanism against the real catalog. `pl_media` is one `media-generator` step:
      // no gate flag, no parking kind, no wait gate, no interview trait, so every check that
      // reads the step CHAIN says it never stops. It ships `comparison` on, which is exactly the
      // park a human answers, and it is the first built-in to set it. Read from the seed so
      // turning the preset's comparison off re-runs this question rather than leaving the
      // assertion true about a pipeline the product no longer ships.
      const media = seedPipelines().find((p) => p.id === 'pl_media')
      expect(media, 'pl_media must exist in the built-in catalog').toBeTruthy()
      expect(media!.agentKinds).toEqual(['media-generator'])
      expect(media!.gates ?? []).not.toContain(true)
      expect(canParkOnHuman(media!, registries)).toBe(true)
      expect(parkSurfacesOf(media!, registries)).toEqual([BINARY_CANDIDATE_PARK_SURFACE])
    })

    it('leaves the unconditional build presets startable by a plain write key', () => {
      // The other side of the same change: widening the enumeration must not sweep up the presets
      // whose whole selling point is that they never pause. If this flips, every `write`-key
      // integration driving ordinary board work breaks at once.
      for (const id of ['pl_build', 'pl_simple']) {
        const pipeline = seedPipelines().find((p) => p.id === id)
        expect(pipeline, `${id} must exist in the built-in catalog`).toBeTruthy()
        expect(canParkOnHuman(pipeline!, registries), id).toBe(false)
      }
    })
  })

  describe('parkSurfacesOf', () => {
    it('names the gate and the kind separately when a step carries both', () => {
      expect(
        parkSurfacesOf({ agentKinds: ['requirements-review'], gates: [true] }, registries),
      ).toEqual(['approval-gate', 'requirements-review'])
    })

    it('dedupes a surface reached by several steps', () => {
      // Two gated steps are ONE thing to tell the caller about, not two.
      expect(
        parkSurfacesOf(
          {
            agentKinds: ['initiative-breakdown', 'task-estimator'],
            gates: [true, true],
          },
          registries,
        ),
      ).toEqual(['approval-gate'])
    })

    it('is empty for a chain that cannot park', () => {
      expect(parkSurfacesOf({ agentKinds: ['initiative-breakdown'] }, registries)).toEqual([])
    })
  })
})

// What a refusal SAYS, split from what detects a park above: the two answer different questions
// (which surfaces does this pipeline have, versus which of them can this API actually answer),
// and holding them apart is what keeps the drift guard below honest about the second.
describe('public-API admission: what the refusal promises', () => {
  describe('parkingRefusalMessage', () => {
    it('promises an answer path ONLY for surfaces the decision surface really serves', () => {
      // The defect this replaced: the old fixed sentence named all four park types and told the
      // operator a `decide` key answers them through /api/v1/runs/:runId/decisions. Most were
      // answerable only in the app, so the advice bought a wider-scoped key and a run whose only
      // exit is cancel.
      //
      // `human-review` is the last surface in that position, and unlike the others it is not a
      // slice waiting to be built: its answer is a person approving the PR on the VCS host, so
      // there is nothing for this surface to offer and the refusal must not pretend otherwise.
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['human-review'] }, registries, {
          inputGateBlocks: false,
        }),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain('human-review')
      expect(message).not.toContain('/api/v1/runs/:runId/decisions')
      expect(message).toContain('POST /api/v1/jobs/:id/cancel')
    })

    it('names the exit route of the surface being refused, not always the jobs cancel', () => {
      // The board-task start applies the same rule, but its abandoned park is freed with `stop`,
      // not with the jobs cancel, so a refusal steering a task caller at `/jobs/:id/cancel` would
      // name a route that 404s for the run it is about. `cancelPath` is required rather than
      // defaulted precisely so a third start surface cannot inherit either of these by accident.
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['human-review'] }, registries, {
          inputGateBlocks: false,
        }),
        { cancelPath: PUBLIC_TASK_STOP_PATH },
      )
      expect(message).toContain('POST /api/v1/tasks/:taskId/stop')
      expect(message).not.toContain('/jobs/:id/cancel')
    })

    it('names both halves when a pipeline mixes answerable and unanswerable parks', () => {
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['requirements-review', 'human-review'] }, registries, {
          inputGateBlocks: false,
        }),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain(
        "Start it with a 'decide'-scope key, which can answer requirements-review through /api/v1/runs/:runId/decisions.",
      )
      expect(message).toContain('cannot answer human-review yet')
    })

    it('promises the answer path for an approval gate, the commonest park of all', () => {
      // The first honesty fix of the decision surface (ADR 0043), and the one an operator meets
      // first: any pipeline can carry a gated step. While it was unanswerable this refusal told
      // them a `decide` key bought nothing but a cancel.
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['initiative-breakdown'], gates: [true] }, registries, {
          inputGateBlocks: false,
        }),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain(
        "Start it with a 'decide'-scope key, which can answer approval-gate through /api/v1/runs/:runId/decisions.",
      )
      expect(message).not.toContain('cancel')
    })

    it('mentions no cancel-only caveat when every park is answerable', () => {
      const message = parkingRefusalMessage(
        publicRunParkSurfaces({ agentKinds: ['requirements-review'] }, registries, {
          inputGateBlocks: false,
        }),
        { cancelPath: PUBLIC_JOB_CANCEL_PATH },
      )
      expect(message).toContain('/api/v1/runs/:runId/decisions')
      expect(message).not.toContain('cancel')
    })

    it('never claims an answer path for a surface outside the answerable set', () => {
      // The drift guard. Landing a new public answer path (ADR 0043) means adding
      // a member to PUBLICLY_ANSWERABLE_PARK_SURFACES; until then no message may advertise one.
      // Covers the human-wait gate too, so a future slice that makes one answerable has to move it
      // into the answerable set rather than leaving the message silently wrong.
      for (const kind of [...PARKING_INLINE_KINDS, 'human-review']) {
        const message = parkingRefusalMessage(
          publicRunParkSurfaces({ agentKinds: [kind] }, registries, { inputGateBlocks: false }),
          { cancelPath: PUBLIC_JOB_CANCEL_PATH },
        )
        expect(message.includes('/api/v1/runs/:runId/decisions'), kind).toBe(
          PUBLICLY_ANSWERABLE_PARK_SURFACES.has(kind),
        )
      }
    })

    it('names the candidate park as unanswerable, and points at the cancel route instead', () => {
      // The keep-decision HAS a route; it is simply not projected onto `/api/v1` yet, so a refusal
      // that advertised the decisions endpoint would steer an operator into minting a wider key
      // that still cannot answer. Same disposition as `human-review`, different reason.
      const message = parkingRefusalMessage(
        publicRunParkSurfaces(
          {
            agentKinds: ['media-generator'],
            stepOptions: [{ binaryOutput: { comparison: { perGenerator: 2 } } }],
          },
          registries,
          { inputGateBlocks: false },
        ),
        { cancelPath: PUBLIC_TASK_STOP_PATH },
      )
      expect(message).toContain(BINARY_CANDIDATE_PARK_SURFACE)
      expect(message).not.toContain('/api/v1/runs/:runId/decisions')
      expect(message).toContain(PUBLIC_TASK_STOP_PATH)
    })
  })

  describe('isHeadlessInlinePipeline (the `headlessStartable` discovery flag)', () => {
    it('is true only when the pipeline is both inline-only and non-parking', () => {
      // This is what a `write`-scope caller can drive end to end with no follow-up. A parking
      // pipeline is still ADMISSIBLE for a `decide` key — it just is not headless-startable.
      expect(isHeadlessInlinePipeline({ agentKinds: ['initiative-breakdown'] }, registries)).toBe(
        true,
      )
      expect(isHeadlessInlinePipeline({ agentKinds: ['requirements-review'] }, registries)).toBe(
        false,
      )
      expect(
        isHeadlessInlinePipeline(
          { agentKinds: ['initiative-breakdown'], gates: [true] },
          registries,
        ),
      ).toBe(false)
      expect(isHeadlessInlinePipeline({ agentKinds: ['coder'] }, registries)).toBe(false)
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
    expect(publicRunParkSurfaces(inlineOnly, registries, { inputGateBlocks: false })).toEqual([])
  })

  it('reports the gate for a non-parking pipeline whose TASK would park the run', () => {
    expect(publicRunParkSurfaces(inlineOnly, registries, { inputGateBlocks: true })).toEqual([
      INPUT_GATE_PARK_SURFACE,
    ])
  })

  it('lists the gate FIRST, since it parks before any step of the pipeline runs', () => {
    const surfaces = publicRunParkSurfaces({ agentKinds: ['requirements-review'] }, registries, {
      inputGateBlocks: true,
    })
    expect(surfaces[0]).toBe(INPUT_GATE_PARK_SURFACE)
    expect(surfaces).toContain('requirements-review')
  })

  it('is answerable, so the refusal steers at the decision surface rather than at cancel', () => {
    // The gate has a public resolve route (`POST /api/v1/runs/:runId/decisions/input-gate/resolve`),
    // so unlike the app-only parks it must NOT be described as cancel-only.
    expect(PUBLICLY_ANSWERABLE_PARK_SURFACES.has(INPUT_GATE_PARK_SURFACE)).toBe(true)
    const message = parkingRefusalMessage(
      publicRunParkSurfaces(inlineOnly, registries, { inputGateBlocks: true }),
      { cancelPath: PUBLIC_JOB_CANCEL_PATH },
    )
    expect(message).toContain(INPUT_GATE_PARK_SURFACE)
    expect(message).toContain('/api/v1/runs/:runId/decisions')
    expect(message).not.toContain('cannot answer')
  })
})
