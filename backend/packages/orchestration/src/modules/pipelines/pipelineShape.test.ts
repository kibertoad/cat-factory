import { describe, expect, it } from 'vitest'
import { seedPipelines } from '@cat-factory/kernel'
import { BUILTIN_GATABLE_KINDS } from '@cat-factory/contracts'
import { AgentKindRegistry } from '@cat-factory/agents'
import {
  assertPipelineLaunchable,
  assertValidBinaryOutputSteps,
  assertValidCompanionPlacement,
  assertValidGating,
  assertValidRunConditions,
  assertValidAgentVariants,
  assertValidSkillSteps,
  assertValidTesterQualityGating,
  validatePipelineShape,
} from './pipelineShape.js'
import { validatePipelineAuthoring } from './pipelineAuthoring.js'

/** A gate config that sets a threshold, so only the rule under test can be the failure. */
const gated = { enabled: true as const, minRisk: 0.5, onMissingEstimate: 'run' as const }

describe('validatePipelineShape', () => {
  it('every built-in seed pipeline is structurally valid (so runs never refuse to start)', () => {
    for (const p of seedPipelines()) {
      expect(() =>
        validatePipelineShape({
          agentKinds: p.agentKinds,
          enabled: p.enabled,
          // `gates` rides along so the built-in catalog is checked against the human-gate /
          // estimate-gate exclusivity rule too — a preset declaring both would otherwise ship and
          // fail only at run start. `stepOptions` rides along for the same reason, so the RUN
          // CONDITIONS the build rungs carry are held to the gatability rule here rather than at a
          // user's run door.
          gates: p.gates,
          gating: p.gating,
          stepOptions: p.stepOptions,
        }),
      ).not.toThrow()
    }
  })

  it('pl_build is the positional default: the design phase plus the everyday loop', () => {
    const pipelines = seedPipelines()
    // The POSITIONAL default: a plain "Start" with no pinned pipeline resolves `pipelines[0]`, so
    // the default rung has to be first. This assertion is what stops a catalog reorder from
    // silently promoting a different rung.
    expect(pipelines[0]!.id).toBe('pl_build')
    const build = pipelines[0]!
    expect(build.agentKinds).toEqual([
      'architect',
      'architect-companion',
      'coder',
      'reviewer',
      'deployer',
      'tester-api',
      'tester-ui',
      'conflicts',
      'ci',
      'merger',
      'disposer',
    ])
    // It includes the design phase but stops short of the requirements interview, which is the
    // whole point of this rung sitting between pl_simple and pl_complex.
    expect(build.agentKinds).not.toContain('requirements-review')
    expect(build.agentKinds).not.toContain('spec-writer')
  })

  it('the fixed rungs are unconditional end to end (no gating, no parks, no estimator)', () => {
    const byId = new Map(seedPipelines().map((p) => [p.id, p]))
    for (const id of ['pl_build', 'pl_simple']) {
      const p = byId.get(id)
      expect(p, `${id} must be a built-in seed pipeline`).toBeTruthy()
      // A fixed rung's shape is known before the run starts: nothing can switch itself on, the run
      // never parks for a human, and there is no estimator to pay for — a pipeline that cannot
      // escalate has nothing to consult an estimate for.
      expect(p!.gating, `${id} must not gate`).toBeUndefined()
      expect(p!.gates, `${id} must not park`).toBeUndefined()
      expect(p!.enabled, `${id} must have no opt-in steps`).toBeUndefined()
      expect(p!.agentKinds, `${id} must not pay for an estimate`).not.toContain('task-estimator')
    }
  })

  it('pl_simple is pl_build minus the design phase, and keeps the same guarded tail', () => {
    const byId = new Map(seedPipelines().map((p) => [p.id, p]))
    const simple = byId.get('pl_simple')!
    const build = byId.get('pl_build')!
    expect(simple.agentKinds).toEqual(
      build.agentKinds.filter((k) => k !== 'architect' && k !== 'architect-companion'),
    )
    // Every rung ends with the same non-negotiable guard tail, so none can merge over a conflict
    // or a red build. Asserted as an ORDERING rather than the literal last three kinds, because
    // `pl_full` legitimately slots its risk-gated `human-review` between `ci` and `merger`.
    for (const p of [simple, build, byId.get('pl_full')!]) {
      // The `disposer` is the one step allowed AFTER the merge, and it is dropped here rather
      // than asserted around: it reclaims the environment and owns no terminal status, so it
      // neither delays nor overwrites `done`. The claim being pinned is about what DECIDES the
      // change's fate, and the merge stays the last of those.
      const kinds = p.agentKinds.filter((k) => k !== 'disposer')
      expect(kinds.at(-1), `${p.id} must end at the merger`).toBe('merger')
      for (const guard of ['conflicts', 'ci']) {
        const at = kinds.indexOf(guard)
        expect(at, `${p.id} must run ${guard}`).toBeGreaterThanOrEqual(0)
        expect(at, `${p.id} must run ${guard} before merging`).toBeLessThan(kinds.length - 1)
      }
      expect(kinds.indexOf('conflicts'), `${p.id} conflicts before ci`).toBeLessThan(
        kinds.indexOf('ci'),
      )
    }
  })

  it('every bugfix preset writes a failing reproduction test BEFORE the fix', () => {
    const byId = new Map(seedPipelines().map((p) => [p.id, p]))
    for (const id of ['pl_bugfix', 'pl_bug_triage']) {
      const kinds = byId.get(id)!.agentKinds
      const repro = kinds.indexOf('repro-test')
      const coder = kinds.indexOf('coder')
      expect(repro, `${id} must write a reproduction test`).toBeGreaterThanOrEqual(0)
      // Order is the whole content of the step: it SEEDS the shared work branch the coder then
      // resumes, so a red test exists before the fix does. It is also the declaration seam the
      // reproduction proof reads — after the coder there would be no pre-fix tree left to prove
      // anything against.
      expect(repro, `${id} must reproduce before it fixes`).toBeLessThan(coder)
    }
  })

  it('the reproduction step is gatable but no built-in preset gates it', () => {
    // The step is the most expensive thing a small bugfix pays for, so an author may gate it off
    // a task estimate. That is deliberately OPT-IN: shipping a preset that gates it would change
    // what every existing bugfix run costs AND silently drop the evidence on whichever tasks the
    // model happened to score low, which is a decision for whoever owns the pipeline.
    expect(BUILTIN_GATABLE_KINDS.has('repro-test')).toBe(true)
    for (const pipeline of seedPipelines()) {
      const index = pipeline.agentKinds.indexOf('repro-test')
      if (index < 0) continue
      expect(
        pipeline.gating?.[index] ?? null,
        `${pipeline.id} must ship the reproduction step ungated`,
      ).toBeNull()
    }
  })

  it('the adaptive build pipeline is estimate-gated off a leading task-estimator', () => {
    const full = seedPipelines().find((p) => p.id === 'pl_full')
    expect(full, 'pl_full must be a built-in seed pipeline').toBeTruthy()
    const kinds = full!.agentKinds
    // The estimator leads, so every gate below it has an estimate to read.
    expect(kinds[0]).toBe('task-estimator')
    // The gated steps are the optional ones; the guards and the implementation are not.
    // `architect-companion` is deliberately absent: it CASCADES off the architect rather than
    // carrying a duplicate copy of its threshold.
    const gatedKinds = kinds.filter((_k, i) => full!.gating?.[i]?.enabled)
    expect(gatedKinds).toEqual(['architect', 'tester-api', 'tester-ui', 'human-review'])
    expect(full!.gating?.[kinds.indexOf('architect-companion')]).toBeNull()
    for (const unconditional of ['coder', 'reviewer', 'deployer', 'conflicts', 'ci', 'merger']) {
      const i = kinds.indexOf(unconditional)
      expect(i, `${unconditional} must be present`).toBeGreaterThanOrEqual(0)
      expect(full!.gating?.[i]?.enabled ?? false, `${unconditional} must be unconditional`).toBe(
        false,
      )
    }
    // No human approval gate at all on the default — the only human checkpoint is the risk-gated
    // `human-review` STEP, which is an escalation rather than an approval pause.
    expect(full!.gates?.some(Boolean) ?? false).toBe(false)
  })

  it('the seeded pl_bug_triage pipeline is recurring-only, well-shaped, and estimator-first', () => {
    const bugTriage = seedPipelines().find((p) => p.id === 'pl_bug_triage')
    expect(bugTriage, 'pl_bug_triage must be a built-in seed pipeline').toBeTruthy()
    const kinds = bugTriage!.agentKinds
    // Structurally valid (the reviewer companion sits adjacent to coder; no invalid gating).
    expect(() =>
      validatePipelineShape({
        agentKinds: kinds,
        enabled: bugTriage!.enabled,
        gates: bugTriage!.gates,
        gating: bugTriage!.gating,
      }),
    ).not.toThrow()
    // Recurring-only: a bug-intake step forces `availability: 'recurring'`, so it fires from a
    // schedule and refuses a one-off manual start.
    expect(bugTriage!.availability).toBe('recurring')
    expect(() =>
      assertPipelineLaunchable(kinds, bugTriage!.availability, 'recurring'),
    ).not.toThrow()
    expect(() => assertPipelineLaunchable(kinds, bugTriage!.availability, 'manual')).toThrow()
    // The task-estimator runs BEFORE any implementation spend (design §6): the estimate is
    // available to gate the expensive downstream steps (repro-test / coder / reviewer / tester).
    const estimatorIdx = kinds.indexOf('task-estimator')
    expect(estimatorIdx).toBeGreaterThanOrEqual(0)
    for (const spend of ['repro-test', 'coder', 'reviewer', 'tester-api']) {
      expect(kinds.indexOf(spend)).toBeGreaterThan(estimatorIdx)
    }
  })

  it('requires a companion to run immediately after a producer it can review', () => {
    expect(() => assertValidCompanionPlacement({ agentKinds: ['reviewer'] })).toThrow()
    // A disabled producer leaves its companion orphaned → rejected.
    expect(() =>
      assertValidCompanionPlacement({ agentKinds: ['coder', 'reviewer'], enabled: [false, true] }),
    ).toThrow()
    // Adjacent producer → companion is valid.
    expect(() => assertValidCompanionPlacement({ agentKinds: ['coder', 'reviewer'] })).not.toThrow()
    // A step slipped between the producer and its companion → rejected (strict adjacency).
    expect(() =>
      assertValidCompanionPlacement({ agentKinds: ['coder', 'tester-api', 'reviewer'] }),
    ).toThrow()
    // Adjacency is over the ENABLED subset: a disabled step between them doesn't break it.
    expect(() =>
      assertValidCompanionPlacement({
        agentKinds: ['coder', 'tester-api', 'reviewer'],
        enabled: [true, false, true],
      }),
    ).not.toThrow()
  })

  it('requires an enabled estimate PRODUCER before any enabled gated step', () => {
    expect(() =>
      assertValidGating({ agentKinds: ['coder', 'reviewer'], gating: [null, gated] }),
    ).toThrow(/no step that produces one runs before it/)
    expect(() =>
      assertValidGating({
        agentKinds: ['task-estimator', 'coder', 'reviewer'],
        gating: [null, null, gated],
      }),
    ).not.toThrow()
    // EITHER producer satisfies it: the reassessor measures the estimate after the change lands,
    // so a gate after one has a real estimate to read (the rule is about the FIELD being
    // populated, not about which agent populated it).
    expect(() =>
      assertValidGating({
        agentKinds: ['coder', 'task-reassessor', 'human-review'],
        gating: [null, null, gated],
      }),
    ).not.toThrow()
    // ...and a DISABLED producer does not: the same enabled-subset reading every other rule takes.
    expect(() =>
      assertValidGating({
        agentKinds: ['coder', 'task-reassessor', 'human-review'],
        enabled: [true, false, true],
        gating: [null, null, gated],
      }),
    ).toThrow(/no step that produces one runs before it/)
    // A disabled gated step imposes no requirement.
    expect(() =>
      assertValidGating({
        agentKinds: ['coder', 'reviewer'],
        enabled: [true, false],
        gating: [null, gated],
      }),
    ).not.toThrow()
  })

  describe('which kinds may be estimate-gated', () => {
    it('allows a PRODUCER whose output later steps read as context', () => {
      // The generalisation past companions: `pl_simple` shipped with no architect and no
      // spec-writer, so skipping either degrades the next step's context rather than breaking it.
      for (const kind of ['architect', 'spec-writer', 'researcher', 'mocker', 'tester-api']) {
        expect(
          () =>
            assertValidGating({
              agentKinds: ['task-estimator', kind, 'coder'],
              gating: [null, gated, null],
            }),
          `${kind} must be gatable`,
        ).not.toThrow()
      }
    })

    it('refuses a step some other mechanism reads structurally', () => {
      // `merger` is the worst case: `runOpensPr` tests `instance.steps` for it to decide whether a
      // committing kind delivers via a PR, so a skipped merger leaves a PR nothing merges.
      // `deployer` provisions what its consumer reads; `conflicts`/`ci` are the guards; `coder` is
      // the work itself.
      for (const kind of ['merger', 'deployer', 'conflicts', 'ci', 'coder', 'bug-intake']) {
        expect(
          () =>
            assertValidGating({
              agentKinds: ['task-estimator', kind],
              gating: [null, gated],
            }),
          `${kind} must not be gatable`,
        ).toThrow(/cannot be estimate-gated/)
      }
    })

    it('honours a DEPLOYMENT-registered kind’s own gatable flag over the built-in set', () => {
      const registry = new AgentKindRegistry()
      registry.register({ kind: 'acme-auditor', systemPrompt: 'audit', gatable: true })
      registry.register({ kind: 'acme-publisher', systemPrompt: 'publish', gatable: false })
      // Registered gatable → allowed, even though it is in no built-in set.
      expect(() =>
        assertValidGating({
          agentKinds: ['task-estimator', 'acme-auditor'],
          gating: [null, gated],
          agentKindRegistry: registry,
        }),
      ).not.toThrow()
      // Registered NOT gatable → refused.
      expect(() =>
        assertValidGating({
          agentKinds: ['task-estimator', 'acme-publisher'],
          gating: [null, gated],
          agentKindRegistry: registry,
        }),
      ).toThrow(/cannot be estimate-gated/)
      // Unregistered, and not a built-in gatable kind → refused (an unknown kind is unconditional).
      expect(() =>
        assertValidGating({
          agentKinds: ['task-estimator', 'acme-unknown'],
          gating: [null, gated],
          agentKindRegistry: registry,
        }),
      ).toThrow(/cannot be estimate-gated/)
    })
  })

  it('refuses a step carrying BOTH a human approval gate and an estimate gate', () => {
    // The estimate may ADD a human checkpoint (a risk-gated `human-review` step) but never cancel
    // an approval pause the author asked for — which is what gating a `gates[i]` step would do
    // below its threshold.
    expect(() =>
      assertValidGating({
        agentKinds: ['task-estimator', 'requirements-review'],
        gates: [false, true],
        gating: [null, gated],
      }),
    ).toThrow(/carries a human approval gate/)
    // The same step without the approval gate is fine.
    expect(() =>
      assertValidGating({
        agentKinds: ['task-estimator', 'requirements-review'],
        gates: [false, false],
        gating: [null, gated],
      }),
    ).not.toThrow()
    // And a human-gated step with no estimate gate is fine.
    expect(() =>
      assertValidGating({
        agentKinds: ['task-estimator', 'requirements-review'],
        gates: [false, true],
        gating: [null, null],
      }),
    ).not.toThrow()
  })

  it('rejects enabled gating with no axis threshold (it would always skip)', () => {
    expect(() =>
      assertValidGating({
        agentKinds: ['task-estimator', 'coder', 'reviewer'],
        gating: [null, null, { enabled: true, onMissingEstimate: 'run' }],
      }),
    ).toThrow(/sets no threshold/)
  })

  describe('tester quality-control gating', () => {
    it('requires an enabled task-estimator before a QC-gated Tester step', () => {
      expect(() =>
        assertValidTesterQualityGating({
          agentKinds: ['coder', 'tester-api'],
          testerQuality: [null, { enabled: true, gating: gated }],
        }),
      ).toThrow()
      expect(() =>
        assertValidTesterQualityGating({
          agentKinds: ['task-estimator', 'coder', 'tester-api'],
          testerQuality: [null, null, { enabled: true, gating: gated }],
        }),
      ).not.toThrow()
    })

    it('rejects a QC gate that sets no axis threshold', () => {
      expect(() =>
        assertValidTesterQualityGating({
          agentKinds: ['task-estimator', 'tester-api'],
          testerQuality: [
            null,
            { enabled: true, gating: { enabled: true, onMissingEstimate: 'run' } },
          ],
        }),
      ).toThrow()
    })

    it('imposes no requirement when QC is enabled-but-ungated, disabled, or gate-disabled', () => {
      // Enabled, no gating → nothing to validate.
      expect(() =>
        assertValidTesterQualityGating({
          agentKinds: ['tester-api'],
          testerQuality: [{ enabled: true }],
        }),
      ).not.toThrow()
      // A disabled Tester step with a QC gate imposes no requirement (it never runs).
      expect(() =>
        assertValidTesterQualityGating({
          agentKinds: ['tester-api'],
          enabled: [false],
          testerQuality: [{ enabled: true, gating: gated }],
        }),
      ).not.toThrow()
      // A QC gate flagged disabled needs no estimator.
      expect(() =>
        assertValidTesterQualityGating({
          agentKinds: ['tester-api'],
          testerQuality: [{ enabled: true, gating: { enabled: false, onMissingEstimate: 'run' } }],
        }),
      ).not.toThrow()
    })
  })
})

describe('assertPipelineLaunchable', () => {
  it('requires a recurring pipeline for a bug-intake step (unset ⇒ both ⇒ rejected)', () => {
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], 'recurring')).not.toThrow()
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], 'both')).toThrow()
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], 'one-off')).toThrow()
    // Absent availability means 'both' → a bug-intake pipeline is still rejected.
    expect(() => assertPipelineLaunchable(['bug-intake', 'coder'], undefined)).toThrow()
    // No bug-intake step → any availability is fine.
    expect(() => assertPipelineLaunchable(['coder'], undefined)).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'recurring')).not.toThrow()
  })

  it('gates the launch origin against the pipeline availability', () => {
    // A manual start of a recurring-only pipeline is refused; a scheduled fire of it is fine.
    expect(() => assertPipelineLaunchable(['coder'], 'recurring', 'manual')).toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'recurring', 'recurring')).not.toThrow()
    // A scheduled fire of a one-off-only pipeline is refused; a manual start of it is fine.
    expect(() => assertPipelineLaunchable(['coder'], 'one-off', 'recurring')).toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'one-off', 'manual')).not.toThrow()
    // 'both' / unset runs either way.
    expect(() => assertPipelineLaunchable(['coder'], 'both', 'manual')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'both', 'recurring')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], undefined, 'manual')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], undefined, 'recurring')).not.toThrow()
  })

  it('skips the origin gate when no origin is supplied (retry/restart re-drive)', () => {
    // A retry re-drives stored steps with no origin — the launch gate must not fire.
    expect(() => assertPipelineLaunchable(['coder'], 'recurring')).not.toThrow()
    expect(() => assertPipelineLaunchable(['coder'], 'one-off')).not.toThrow()
  })

  it('evaluates the bug-intake requirement over the enabled subset', () => {
    // A DISABLED bug-intake step never runs, so it imposes no recurring requirement — the
    // pipeline may be saved as 'both'/'one-off' (parity with every other check in this file).
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'both', undefined, [false, true]),
    ).not.toThrow()
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'one-off', 'manual', [false, true]),
    ).not.toThrow()
    // An ENABLED bug-intake step (explicit true, or default when the mask omits it) still requires
    // recurring.
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'both', undefined, [true, true]),
    ).toThrow()
    expect(() =>
      assertPipelineLaunchable(['bug-intake', 'coder'], 'both', undefined, [
        undefined as never,
        true,
      ]),
    ).toThrow()
  })
})

describe('assertValidRunConditions', () => {
  /** A step-options bag carrying only a run condition, so only the rule under test can fail. */
  const conditional = (serviceScope: 'frontend' | 'backend') => ({ condition: { serviceScope } })

  it('accepts a condition on a gatable kind', () => {
    // The tester pair is the case the axis exists for, and both halves are gatable kinds.
    expect(() =>
      assertValidRunConditions({
        agentKinds: ['coder', 'tester-api', 'tester-ui'],
        stepOptions: [null, conditional('backend'), conditional('frontend')],
      }),
    ).not.toThrow()
  })

  it('refuses a condition on a kind that may not be skipped', () => {
    // A condition on `merger` drops the merge on every run outside its scope while the pipeline
    // still reports success — the same failure the estimate gate refuses, reached by the other axis.
    for (const kind of ['merger', 'coder', 'ci', 'conflicts']) {
      expect(() =>
        assertValidRunConditions({
          agentKinds: [kind],
          stepOptions: [conditional('frontend')],
        }),
      ).toThrow(/cannot carry a run condition/)
    }
  })

  it('refuses a condition on a step that also carries a human approval gate', () => {
    expect(() =>
      assertValidRunConditions({
        agentKinds: ['tester-ui'],
        gates: [true],
        stepOptions: [conditional('frontend')],
      }),
    ).toThrow(/never remove one/)
  })

  it('ACCEPTS a condition beside an estimate gate: the two axes compose', () => {
    // Deliberately not refused — "does this step apply to this kind of change" and "is this change
    // big enough" are different questions, and a UI pass wanted only on frontend work above a
    // complexity floor is coherent. Asserted so the pair is never refused by accident.
    expect(() =>
      assertValidRunConditions({
        agentKinds: ['task-estimator', 'tester-ui'],
        gating: [null, gated],
        stepOptions: [null, conditional('frontend')],
      }),
    ).not.toThrow()
  })

  it('imposes no requirement on a DISABLED conditional step', () => {
    expect(() =>
      assertValidRunConditions({
        agentKinds: ['merger'],
        enabled: [false],
        stepOptions: [conditional('frontend')],
      }),
    ).not.toThrow()
  })

  it("honours a DEPLOYMENT-registered kind's own gatable flag", () => {
    // Same registry asymmetry the estimate gate has: a deployment that registers a kind owns the
    // answer for it, so a registered gatable kind is accepted here as it is there.
    const registry = new AgentKindRegistry()
    registry.register({ kind: 'org:auditor', gatable: true, spec: { track: 'reviewing' } } as never)
    expect(() =>
      assertValidRunConditions({
        agentKinds: ['org:auditor'],
        stepOptions: [conditional('frontend')],
        agentKindRegistry: registry,
      }),
    ).not.toThrow()
  })
})

describe('assertValidSkillSteps', () => {
  it('rejects an enabled skill step that selects no skill', () => {
    expect(() => assertValidSkillSteps({ agentKinds: ['skill'] })).toThrow(/must select a skill/)
    expect(() => assertValidSkillSteps({ agentKinds: ['skill'], stepOptions: [{}] })).toThrow(
      /must select a skill/,
    )
    expect(() =>
      assertValidSkillSteps({ agentKinds: ['skill'], stepOptions: [{ skillId: '  ' }] }),
    ).toThrow(/must select a skill/)
  })

  it('accepts a skill step that names a skill', () => {
    expect(() =>
      assertValidSkillSteps({
        agentKinds: ['coder', 'skill'],
        stepOptions: [null, { skillId: 'src:s:x' }],
      }),
    ).not.toThrow()
  })

  it('imposes no requirement on a DISABLED skill step', () => {
    expect(() => assertValidSkillSteps({ agentKinds: ['skill'], enabled: [false] })).not.toThrow()
  })

  it('ignores stepOptions.skillId on a non-skill kind', () => {
    expect(() => assertValidSkillSteps({ agentKinds: ['coder'], stepOptions: [{}] })).not.toThrow()
  })
})

describe('assertValidAgentVariants', () => {
  /** A registry carrying one variant of `coder`, as a deployment package would register it. */
  function registryWithVariant() {
    const registry = new AgentKindRegistry()
    registry.registerVariant({ id: 'org:tdd', baseKind: 'coder', promptAddition: 'test-first' })
    return registry
  }

  it('accepts a step selecting a variant of its own kind', () => {
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['coder'],
        stepOptions: [{ agentVariantId: 'org:tdd' }],
        agentKindRegistry: registryWithVariant(),
      }),
    ).not.toThrow()
  })

  it('rejects a variant this deployment does not register', () => {
    // Without this the step would silently run the SHIPPED prompt — it still works, so nothing
    // surfaces except that it quietly stopped being the variation someone configured.
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['coder'],
        stepOptions: [{ agentVariantId: 'org:missing' }],
        agentKindRegistry: registryWithVariant(),
      }),
    ).toThrow(/does not register/)
  })

  it('rejects a variant of ANOTHER kind — it would run this step under the wrong role', () => {
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['architect'],
        stepOptions: [{ agentVariantId: 'org:tdd' }],
        agentKindRegistry: registryWithVariant(),
      }),
    ).toThrow(/cannot be selected on a 'architect' step/)
  })

  it('refuses a variant on an INLINE-ENGINE step, which could never apply it', () => {
    // `requirements-review` runs inline in the engine, which composes its prompt from
    // (workspace, kind) with no step — so the selection would validate, save, run, and silently
    // do nothing. Refusing is the honest disposition while that path has no step to read.
    const registry = new AgentKindRegistry()
    registry.registerVariant({
      id: 'org:strict',
      baseKind: 'requirements-review',
      promptAddition: 'Be strict.',
    })
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['requirements-review'],
        stepOptions: [{ agentVariantId: 'org:strict' }],
        agentKindRegistry: registry,
      }),
    ).toThrow(/runs inline in the engine/)
  })

  it('still accepts a variant on a BESPOKE-prompt CONTAINER kind', () => {
    // The distinction the inline refusal must not over-reach on: `merger` also carries a bespoke
    // prompt, but it dispatches through the engine like any container kind, so a variant applies.
    const registry = new AgentKindRegistry()
    registry.registerVariant({
      id: 'org:cautious',
      baseKind: 'merger',
      promptAddition: 'Weigh migrations as high risk.',
    })
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['merger'],
        stepOptions: [{ agentVariantId: 'org:cautious' }],
        agentKindRegistry: registry,
      }),
    ).not.toThrow()
  })

  it('imposes no requirement on a DISABLED step', () => {
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['coder'],
        enabled: [false],
        stepOptions: [{ agentVariantId: 'org:missing' }],
        agentKindRegistry: registryWithVariant(),
      }),
    ).not.toThrow()
  })

  it('skips the check entirely with no registry in view (the built-in-catalog caller)', () => {
    expect(() =>
      assertValidAgentVariants({
        agentKinds: ['coder'],
        stepOptions: [{ agentVariantId: 'org:tdd' }],
      }),
    ).not.toThrow()
  })
})

describe('assertValidBinaryOutputSteps', () => {
  /** A registry carrying a binary-generating kind, as a deployment package would register it. */
  function registryWithGenerator() {
    const registry = new AgentKindRegistry()
    registry.register({
      kind: 'image-generator',
      systemPrompt: 'You generate images.',
      traits: ['binary-output'],
    })
    return registry
  }

  it('rejects an enabled generator step that selects no storage service', () => {
    for (const stepOptions of [undefined, [null], [{}]]) {
      expect(() =>
        assertValidBinaryOutputSteps({
          agentKinds: ['image-generator'],
          ...(stepOptions ? { stepOptions } : {}),
          agentKindRegistry: registryWithGenerator(),
        }),
      ).toThrow(/selects no storage service/)
    }
  })

  it('accepts a generator step that selects one', () => {
    expect(() =>
      assertValidBinaryOutputSteps({
        agentKinds: ['coder', 'image-generator'],
        stepOptions: [null, { binaryOutput: { storageServiceId: 'asset-store' } }],
        agentKindRegistry: registryWithGenerator(),
      }),
    ).not.toThrow()
  })

  it('imposes no requirement on a DISABLED generator step or a non-generator kind', () => {
    expect(() =>
      assertValidBinaryOutputSteps({
        agentKinds: ['image-generator'],
        enabled: [false],
        agentKindRegistry: registryWithGenerator(),
      }),
    ).not.toThrow()
    expect(() =>
      assertValidBinaryOutputSteps({
        agentKinds: ['coder'],
        stepOptions: [{}],
        agentKindRegistry: registryWithGenerator(),
      }),
    ).not.toThrow()
  })

  it('skips the check entirely with no registry in view (the built-in-catalog caller)', () => {
    expect(() => assertValidBinaryOutputSteps({ agentKinds: ['image-generator'] })).not.toThrow()
  })

  // An exact size and a second statement of the same fact. Refused rather than resolved by
  // precedence, because the party a precedence rule leaves the decision to is the agent writing
  // the vendor call, reading both numbers in one brief.
  describe('an exact output size states the dimensions once', () => {
    const step = (generation: Record<string, unknown>) => () =>
      assertValidBinaryOutputSteps({
        agentKinds: ['image-generator'],
        stepOptions: [{ binaryOutput: { storageServiceId: 'asset-store', generation } }],
        agentKindRegistry: registryWithGenerator(),
      })

    it('accepts a size on its own, and each neighbour on its own', () => {
      expect(step({ outputSize: { width: 96, height: 96 } })).not.toThrow()
      expect(step({ aspectRatio: '16:9' })).not.toThrow()
      expect(step({ upscale: 2 })).not.toThrow()
    })

    it('refuses a size beside an aspect ratio or an upscale, naming both', () => {
      expect(step({ outputSize: { width: 96, height: 96 }, aspectRatio: '16:9' })).toThrow(
        /96x96.*aspect ratio of 16:9/s,
      )
      expect(step({ outputSize: { width: 96, height: 96 }, upscale: 2 })).toThrow(/upscale of 2x/)
      // Both at once is ONE refusal naming the whole fix, the same rule the unresolved-id
      // refusals follow: a step with two problems must not cost two save-fix rounds.
      expect(
        step({ outputSize: { width: 96, height: 96 }, aspectRatio: '1:1', upscale: 2 }),
      ).toThrow(/aspect ratio of 1:1 and an upscale of 2x/)
    })
  })
})

// The AUTHORING rules (`validatePipelineAuthoring`) are a layer above the shape validation: what
// is INCOMPLETE rather than what is BROKEN, and so bound to the save door alone. Their own
// behaviour is unit-tested beside the rule in contracts; what belongs HERE is the one claim that
// needs the shipped catalog in view.
describe('validatePipelineAuthoring — against the shipped catalog', () => {
  it('accepts every built-in seed pipeline, so one can be cloned and edited', () => {
    // A built-in that failed these would be a preset the platform ships and its own builder
    // refuses to save: clone it, change the name, and the save is rejected for a fault the user
    // did not introduce, with no reseed to escape by. The catalog is the one place that cannot
    // be allowed to drift from them.
    for (const p of seedPipelines()) {
      expect(
        () =>
          validatePipelineAuthoring({
            agentKinds: p.agentKinds,
            enabled: p.enabled,
            stepOptions: p.stepOptions,
          }),
        p.id,
      ).not.toThrow()
    }
  })
})
