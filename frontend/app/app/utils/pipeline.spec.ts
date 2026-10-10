import { describe, expect, it } from 'vitest'
import {
  agentCategorySchema,
  isAgentCategory,
  isPipelinePurpose,
  PIPELINE_PURPOSES,
  pipelineAllowedForBlockLevel,
  pipelineAllowedForTaskType,
  pipelineMatchesPurpose,
  pipelineRunsVisualStep,
  purposeAllowsAgentCategory,
  purposeSuggestsAgentCategory,
  purposeSuggestsAgentKind,
  resolveRunServiceScope,
} from '@cat-factory/contracts'
import type { PipelinePurpose } from '@cat-factory/contracts'
import type { Block, Pipeline } from '~/types/domain'
import {
  pipelineAllowedForFrame,
  pipelineAllowedForManualStart,
  pipelineAllowedForSchedule,
  pipelineConditionalCount,
  pipelineDisplaySteps,
  pipelineGateCount,
} from '~/utils/pipeline'

// The palette categories, read off the schema the predicates themselves are typed against, so a
// new category joins these sweeps instead of quietly going unasserted behind a hand-listed tuple.
const AGENT_CATEGORIES = agentCategorySchema.options

// A `purpose` typed as a member and only DECLARED to be one: `Pipeline.purpose` is persisted and
// no boundary re-checks it against the union this build compiled, so a browser on a cached bundle
// sees a member shipped after it and a retired member goes on living in saved rows. Same story for
// a `presentation.category`, which arrives in the snapshot from a deployment-registered kind.
const UNKNOWN_PURPOSE = 'acme-migration' as never
const UNKNOWN_CATEGORY = 'observability' as never

// A minimal pipeline: only the fields the launch/task-type filters read matter here.
function pipeline(over: Partial<Pipeline> = {}): Pipeline {
  return { id: 'pl_x', name: 'X', agentKinds: ['coder'], ...over } as Pipeline
}

// The data behind every picker's preview pane: the ordered steps a run will actually execute.
describe('pipelineDisplaySteps', () => {
  it('keeps the authored order and flags the gated steps', () => {
    const p = pipeline({
      agentKinds: ['task-estimator', 'coder', 'reviewer'],
      gates: [false, true, false],
    })
    expect(pipelineDisplaySteps(p)).toEqual([
      { kind: 'task-estimator', gated: false, conditions: [] },
      { kind: 'coder', gated: true, conditions: [] },
      { kind: 'reviewer', gated: false, conditions: [] },
    ])
  })

  it('names every reason a step may be skipped, on the step itself', () => {
    // The two causes are reported separately because a reader acts on them differently: an
    // estimate gate is a knob on the pipeline, a service condition is a fact about the task.
    const p = pipeline({
      agentKinds: ['task-estimator', 'tester-api', 'tester-ui'],
      gating: [null, { enabled: true, minRisk: 0.3, onMissingEstimate: 'run' }, null],
      stepOptions: [
        null,
        { condition: { serviceScope: 'backend' } },
        { condition: { serviceScope: 'frontend' } },
      ],
    })
    expect(pipelineDisplaySteps(p).map((s) => s.conditions)).toEqual([
      [],
      ['estimate', 'backend'],
      ['frontend'],
    ])
    expect(pipelineConditionalCount(p)).toBe(2)
  })

  it('LISTS a conditional step rather than filtering it out', () => {
    // Which conditional steps run is a fact about the TASK, and this preview is read while
    // choosing a pipeline — before there is a task to answer it. Hiding them understates the
    // pipeline; listing them silently overstates it, which is what `conditions` fixes.
    const p = pipeline({
      agentKinds: ['coder', 'tester-ui'],
      stepOptions: [null, { condition: { serviceScope: 'frontend' } }],
    })
    expect(pipelineDisplaySteps(p).map((s) => s.kind)).toEqual(['coder', 'tester-ui'])
  })

  it('drops steps disabled by default — they never run, so listing them would misdescribe it', () => {
    // The short `enabled` array also pins "no entry ⇒ enabled": `tester` has none and stays.
    const p = pipeline({ agentKinds: ['architect', 'coder', 'tester'], enabled: [false, true] })
    expect(pipelineDisplaySteps(p).map((s) => s.kind)).toEqual(['coder', 'tester'])
  })
})

describe('pipelineGateCount', () => {
  it('counts only the gates that a run can actually stop at', () => {
    expect(pipelineGateCount(pipeline({ agentKinds: ['coder'] }))).toBe(0)
    expect(
      pipelineGateCount(pipeline({ agentKinds: ['coder', 'merger'], gates: [true, true] })),
    ).toBe(2)
    // A gate declared on a disabled step gates nothing: the step is skipped at run.
    expect(
      pipelineGateCount(
        pipeline({ agentKinds: ['coder', 'merger'], gates: [true, true], enabled: [true, false] }),
      ),
    ).toBe(1)
  })
})

describe('pipelineAllowedForTaskType', () => {
  it('a document task offers ONLY document-purpose pipelines', () => {
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'document' }), 'document')).toBe(true)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'build' }), 'document')).toBe(false)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'research' }), 'document')).toBe(false)
    // A classifier this build cannot NAME is hidden too: this narrowing requires the explicit
    // member, because a non-document pipeline on a document task authors no document at all.
    expect(pipelineAllowedForTaskType(pipeline({ purpose: UNKNOWN_PURPOSE }), 'document')).toBe(
      false,
    )
  })

  it('a review task offers ONLY review-purpose pipelines', () => {
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'review' }), 'review')).toBe(true)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'build' }), 'review')).toBe(false)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'document' }), 'review')).toBe(false)
    // Same disposition as the document task's, for the same reason.
    expect(pipelineAllowedForTaskType(pipeline({ purpose: UNKNOWN_PURPOSE }), 'review')).toBe(false)
  })

  it('a programmatic task (feature / bug) hides only what cannot ship code', () => {
    // These ship code, so a doc-authoring or PR-review preset is meaningless for them — the mirror
    // of the narrowing document/review tasks already had. `research` stays because reaching for a
    // spike before committing to an approach is legitimate on an unscoped feature.
    for (const type of ['feature', 'bug'] as const) {
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'build' }), type)).toBe(true)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'research' }), type)).toBe(true)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'document' }), type)).toBe(false)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'review' }), type)).toBe(false)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'planning' }), type)).toBe(false)
    }
  })

  it('offers a bugfix preset to a bug task and withholds it from a feature', () => {
    // "Triage & fix bug" investigates a defect REPORT, triages it with a person and writes a
    // failing reproduction test before anything is fixed. A feature has no report to investigate
    // and nothing red to turn green, so the front half of the run has no input at all. The bug
    // task still gets the whole build ladder beside it — this narrows one preset, not the type.
    const bugfix = pipeline({ purpose: 'bugfix' })
    expect(pipelineAllowedForTaskType(bugfix, 'bug')).toBe(true)
    expect(pipelineAllowedForTaskType(bugfix, 'feature')).toBe(false)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'build' }), 'bug')).toBe(true)
    // And it stays out of the task types that demand their own explicit member.
    expect(pipelineAllowedForTaskType(bugfix, 'document')).toBe(false)
    expect(pipelineAllowedForTaskType(bugfix, 'review')).toBe(false)
    // An un-narrowed type (spike, ralph, a deployment's own) is unrestricted as ever.
    expect(pipelineAllowedForTaskType(bugfix, 'spike')).toBe(true)
  })

  it('keeps a pipeline whose classifier this build cannot name on a feature / bug task', () => {
    // The one place this narrowing runs opposite to the document/review one, and it has to. The
    // value is persisted, so a deployment's own classifier (or one retired since the row was
    // written) reaches a bundle with no member for it — and hiding it would take that pipeline out
    // of the picker people use most, silently, with nothing on screen to explain the absence. It is
    // not known-wrong for a feature the way a document preset is.
    for (const type of ['feature', 'bug'] as const) {
      expect(pipelineAllowedForTaskType(pipeline({ purpose: UNKNOWN_PURPOSE }), type)).toBe(true)
    }
    // Still hidden from the types whose narrowing DOES demand the explicit member.
    expect(pipelineAllowedForTaskType(pipeline({ purpose: UNKNOWN_PURPOSE }), 'document')).toBe(
      false,
    )
    expect(pipelineAllowedForTaskType(pipeline({ purpose: UNKNOWN_PURPOSE }), 'review')).toBe(false)
  })

  it('an un-narrowed task type stays unrestricted (spike, ralph, custom, undefined)', () => {
    // A custom (namespaced) deployment type has no purpose mapping we could infer, and `spike` /
    // `ralph` pin their own default pipeline instead of narrowing the picker.
    for (const type of ['spike', 'ralph', 'acme:incident', undefined] as const) {
      for (const purpose of ['build', 'document', 'review', 'research'] as const) {
        expect(pipelineAllowedForTaskType(pipeline({ purpose }), type)).toBe(true)
      }
    }
  })
})

describe('pipelineAllowedForBlockLevel (initiative binding)', () => {
  it('offers an initiative block only planning pipelines', () => {
    expect(pipelineAllowedForBlockLevel(pipeline({ purpose: 'planning' }), 'initiative')).toBe(true)
    for (const purpose of ['build', 'document', 'review', 'research', undefined] as const) {
      expect(pipelineAllowedForBlockLevel(pipeline({ purpose }), 'initiative')).toBe(false)
    }
  })

  it('hides planning pipelines from every ordinary block level', () => {
    // The surface half of the engine's BIDIRECTIONAL guard. Without it the planning presets were
    // offered on ordinary tasks and then refused at start with a 409 — the user having already
    // chosen before learning it could not run.
    for (const level of ['task', 'frame', 'module', 'epic'] as const) {
      expect(pipelineAllowedForBlockLevel(pipeline({ purpose: 'planning' }), level)).toBe(false)
      expect(pipelineAllowedForBlockLevel(pipeline({ purpose: 'build' }), level)).toBe(true)
    }
  })

  it('is unrestricted when the level is unknown', () => {
    for (const purpose of ['build', 'planning', undefined] as const) {
      expect(pipelineAllowedForBlockLevel(pipeline({ purpose }), undefined)).toBe(true)
    }
  })
})

describe('purposeAllowsAgentCategory (builder save gate)', () => {
  it('a code-shipping pipeline, and one whose classifier this build cannot name, may use every category', () => {
    // `bugfix` rides with `build` here: the two differ only in the task type they are OFFERED to,
    // and a bug fix designs, implements, tests and merges like any other change.
    for (const purpose of ['build', 'bugfix', UNKNOWN_PURPOSE] as const) {
      for (const cat of AGENT_CATEGORIES) {
        expect(purposeAllowsAgentCategory(purpose, cat)).toBe(true)
      }
    }
  })

  it('a non-build pipeline refuses the Implementation (build) and Testing (test) categories', () => {
    for (const purpose of ['document', 'review', 'research', 'planning'] as const) {
      expect(purposeAllowsAgentCategory(purpose, 'build')).toBe(false)
      expect(purposeAllowsAgentCategory(purpose, 'test')).toBe(false)
      // Everything else stays SAVEABLE even where the palette stops offering it (below), so a
      // stored pipeline never becomes unsaveable because the relevance table gained an opinion.
      expect(purposeAllowsAgentCategory(purpose, 'docs')).toBe(true)
      expect(purposeAllowsAgentCategory(purpose, 'review')).toBe(true)
      expect(purposeAllowsAgentCategory(purpose, 'gates')).toBe(true)
    }
  })
})

describe('purposeSuggestsAgentCategory (builder palette filter)', () => {
  it('offers the whole catalog to a code-shipping pipeline, and to one it cannot name', () => {
    for (const purpose of ['build', 'bugfix', UNKNOWN_PURPOSE] as const) {
      for (const cat of AGENT_CATEGORIES) {
        expect(purposeSuggestsAgentCategory(purpose, cat)).toBe(true)
      }
    }
  })

  it('narrows each purpose to the categories it has a use for', () => {
    // A PR review designs nothing and builds nothing; the plan an initiative pipeline produces
    // is its own in-repo tracker, with no pull request to gate and no repo docs to write.
    expect(purposeSuggestsAgentCategory('review', 'design')).toBe(false)
    expect(purposeSuggestsAgentCategory('review', 'review')).toBe(true)
    expect(purposeSuggestsAgentCategory('planning', 'gates')).toBe(false)
    expect(purposeSuggestsAgentCategory('planning', 'docs')).toBe(false)
    expect(purposeSuggestsAgentCategory('planning', 'design')).toBe(true)
    // Authoring a document and running a spike are researched and reviewed like any change.
    for (const purpose of ['document', 'research'] as const) {
      expect(purposeSuggestsAgentCategory(purpose, 'design')).toBe(true)
      expect(purposeSuggestsAgentCategory(purpose, 'docs')).toBe(true)
    }
  })

  it('never offers what the save gate would refuse', () => {
    // The invariant that keeps the two tables honest, over the whole grid rather than the cells
    // that happen to differ today: relevance may hide more than compatibility, never less, or
    // the palette would offer a kind whose step then blocks the save. The unknown purpose rides
    // the same sweep because it is the case where the two could most easily read the same value
    // in opposite directions, one narrowing by it and the other not.
    for (const purpose of [...PIPELINE_PURPOSES, UNKNOWN_PURPOSE]) {
      for (const cat of AGENT_CATEGORIES) {
        if (purposeSuggestsAgentCategory(purpose, cat)) {
          expect(purposeAllowsAgentCategory(purpose, cat)).toBe(true)
        }
      }
    }
  })
})

describe('purposeSuggestsAgentKind (what the palette actually filters on)', () => {
  it('defers to the category for a kind that declares no purposes of its own', () => {
    // The normal case, and the one that keeps a deployment-registered kind exactly as visible as
    // it was before kinds could speak for themselves.
    for (const purpose of [...PIPELINE_PURPOSES, UNKNOWN_PURPOSE]) {
      for (const category of AGENT_CATEGORIES) {
        expect(purposeSuggestsAgentKind(purpose, { category })).toBe(
          purposeSuggestsAgentCategory(purpose, category),
        )
      }
      expect(purposeSuggestsAgentKind(purpose, {})).toBe(true)
    }
  })

  it('lets a kind narrow within a category its siblings still belong to', () => {
    // What the category table structurally cannot say: `docs` survives a `review` pipeline so the
    // Domain Rules Reviewer does, which also handed it the two kinds that WRITE documentation.
    const author = { category: 'docs', purposes: ['build', 'document'] } as const
    expect(purposeSuggestsAgentKind('document', author)).toBe(true)
    expect(purposeSuggestsAgentKind('review', author)).toBe(false)
    expect(purposeSuggestsAgentCategory('review', 'docs')).toBe(true)
  })

  it('reads a `build` declaration as covering `bugfix`, but not the other way round', () => {
    // The two purposes are the same WORK, split only so the pickers can withhold a defect-report
    // preset from a feature task. Every kind declaring `build` predates the split, so without
    // this the bugfix palette would open nearly empty — the Bug Investigator included.
    const builder = { category: 'build', purposes: ['build'] } as const
    expect(purposeSuggestsAgentKind('bugfix', builder)).toBe(true)
    expect(purposeSuggestsAgentKind('document', builder)).toBe(false)
    // One-way: naming only `bugfix` claims the defect-report context, not builds in general.
    const bugOnly = { category: 'build', purposes: ['bugfix'] } as const
    expect(purposeSuggestsAgentKind('bugfix', bugOnly)).toBe(true)
    expect(purposeSuggestsAgentKind('build', bugOnly)).toBe(false)
    // ONE relation, not one per surface: the saved-pipeline library reads it through the same
    // helper, so a draft cannot find the build ladder in its palette and not in its library.
    expect(pipelineMatchesPurpose({ purpose: 'build' } as Pipeline, 'bugfix')).toBe(true)
    expect(pipelineMatchesPurpose({ purpose: 'bugfix' } as Pipeline, 'build')).toBe(false)
  })

  it('is a declaration, not an exemption from the category', () => {
    // A kind cannot buy its way back into a purpose its section is not offered to: `docs` is gone
    // for `planning`, and the palette drops the kind whether or not it named `planning` itself.
    const doc = { category: 'docs', purposes: ['planning'] } as const
    expect(purposeSuggestsAgentKind('planning', doc)).toBe(
      purposeSuggestsAgentCategory('planning', 'docs'),
    )
  })

  it('reads a list naming nothing this build knows as no declaration at all', () => {
    const stale = { category: 'docs', purposes: [UNKNOWN_PURPOSE] } as const
    for (const purpose of PIPELINE_PURPOSES) {
      expect(purposeSuggestsAgentKind(purpose, stale)).toBe(
        purposeSuggestsAgentCategory(purpose, 'docs'),
      )
    }
    // And a purpose this build cannot name still narrows nothing, declaration or not.
    expect(
      purposeSuggestsAgentKind(UNKNOWN_PURPOSE, { category: 'docs', purposes: ['build'] }),
    ).toBe(true)
  })

  it('never offers what the save gate would refuse', () => {
    // The same invariant the category predicate carries, restated where the palette now reads it:
    // a kind's own declaration may only ever hide more, so it can never open a hole through which
    // a kind is offered and its step then blocks the save.
    for (const purpose of [...PIPELINE_PURPOSES, UNKNOWN_PURPOSE]) {
      for (const category of AGENT_CATEGORIES) {
        const declarations: (readonly PipelinePurpose[] | undefined)[] = [
          undefined,
          PIPELINE_PURPOSES,
          ['build'],
          [UNKNOWN_PURPOSE],
        ]
        for (const purposes of declarations) {
          if (purposeSuggestsAgentKind(purpose, { category, purposes })) {
            expect(purposeAllowsAgentCategory(purpose, category)).toBe(true)
          }
        }
      }
    }
  })
})

describe('a purpose or category this build does not recognise', () => {
  it('is recognised as unknown rather than trusted', () => {
    for (const purpose of PIPELINE_PURPOSES) expect(isPipelinePurpose(purpose)).toBe(true)
    for (const cat of AGENT_CATEGORIES) expect(isAgentCategory(cat)).toBe(true)
    expect(isPipelinePurpose('acme-migration')).toBe(false)
    expect(isPipelinePurpose('')).toBe(false)
    expect(isAgentCategory('observability')).toBe(false)
  })

  it('narrows nothing, in the palette or the save gate', () => {
    // Both predicates index a table by these values, so before the guards an unknown purpose threw
    // inside the palette's computed and white-screened the builder, while an unknown category read
    // as `undefined` and silently dropped a registered kind the save gate would have accepted.
    // Unknown means this build has nothing to narrow by, which is exactly what absent already means.
    for (const cat of AGENT_CATEGORIES) {
      expect(purposeSuggestsAgentCategory(UNKNOWN_PURPOSE, cat)).toBe(true)
      expect(purposeAllowsAgentCategory(UNKNOWN_PURPOSE, cat)).toBe(true)
    }
    for (const purpose of PIPELINE_PURPOSES) {
      expect(purposeSuggestsAgentCategory(purpose, UNKNOWN_CATEGORY)).toBe(true)
    }
  })
})

describe('pipelineAllowedForFrame (the visual gate)', () => {
  const serviceFrame = { id: 'blk_svc', level: 'frame', type: 'service' } as Block
  const frontendFrame = { id: 'blk_fe', level: 'frame', type: 'frontend' } as Block

  // Every build rung ships the CONDITIONAL tester pair: the browser pass declares the frontend
  // scope, the API pass the backend one, so one preset covers both kinds of service.
  const buildRung = pipeline({
    purpose: 'build',
    agentKinds: ['coder', 'tester-api', 'tester-ui', 'merger'],
    stepOptions: [
      null,
      { condition: { serviceScope: 'backend' } },
      { condition: { serviceScope: 'frontend' } },
      null,
    ],
  })

  it('offers a build rung on a plain backend service — its UI pass is scoped out', () => {
    // The regression: reading "does the pipeline LIST a visual step" hid Standard / Simple /
    // Adaptive / Complex build from the pickers on every non-frontend service, while the engine
    // would have started any of them (it drops the condition-excluded steps before its own gate).
    expect(pipelineAllowedForFrame(buildRung, serviceFrame, [serviceFrame])).toBe(true)
    expect(pipelineAllowedForManualStart(buildRung, serviceFrame, [serviceFrame], 'feature')).toBe(
      true,
    )
  })

  it('offers it on a frontend frame too, where the UI pass is exactly what runs', () => {
    // Stated as the premise, not just the answer: on this frame the condition ADMITS the browser
    // pass, so the gate is passing on the frame half rather than on the step being scoped out.
    // Without it the case reads identically against the pre-fix implementation, which reached the
    // same `true` down the other branch and asserted nothing about the change.
    expect(pipelineRunsVisualStep(buildRung, resolveRunServiceScope([frontendFrame]))).toBe(true)
    expect(pipelineAllowedForFrame(buildRung, frontendFrame, [frontendFrame])).toBe(true)
  })

  it('offers everything on a service frame a FRONTEND binds as its backend', () => {
    // The other half of `frameAllowsVisualPipeline`, and the branch with the widest reach: the
    // linked frontend is the UI a change to this service is validated through, so the frame has a
    // UI and even an unconditional visual pipeline may run on it.
    const boundService = { id: 'blk_api', level: 'frame', type: 'service' } as Block
    const binder = {
      id: 'blk_fe',
      level: 'frame',
      type: 'frontend',
      frontendConfig: {
        backendBindings: [
          { envVar: 'API_URL', source: { kind: 'service', serviceBlockId: 'blk_api' } },
        ],
      },
    } as Block
    const blocks = [boundService, binder]
    const visual = pipeline({ purpose: 'build', agentKinds: ['coder', 'visual-confirmation'] })
    expect(pipelineAllowedForFrame(buildRung, boundService, blocks)).toBe(true)
    expect(pipelineAllowedForFrame(visual, boundService, blocks)).toBe(true)
    // ...and it is the BINDING that does it, not the mere presence of a frontend on the board.
    expect(pipelineAllowedForFrame(visual, boundService, [boundService, frontendFrame])).toBe(false)
  })

  it('still hides a pipeline whose visual step is UNCONDITIONAL on a frame with no UI', () => {
    // The gate the conditional pair did not repeal: a `visual-confirmation` step with nothing to
    // scope it out has no app to show a person, and the engine answers a 409.
    const visual = pipeline({ purpose: 'build', agentKinds: ['coder', 'visual-confirmation'] })
    expect(pipelineAllowedForFrame(visual, serviceFrame, [serviceFrame])).toBe(false)
    expect(pipelineAllowedForFrame(visual, frontendFrame, [frontendFrame])).toBe(true)
  })

  it('hides a conditional visual pipeline when the frame cannot be resolved', () => {
    // No frame ⇒ no scope to judge the condition against, so the step counts and the frame half
    // refuses. The fail-safe direction, and the same answer the engine gives.
    expect(pipelineAllowedForFrame(buildRung, undefined, [])).toBe(false)
  })
})

describe('pipelineAllowedForManualStart composes the task-type gate', () => {
  const noFrame = undefined
  const blocks: Block[] = []

  it('drops a mismatched pipeline for a document / review task, keeps it for others', () => {
    const build = pipeline({ purpose: 'build' })
    expect(pipelineAllowedForManualStart(build, noFrame, blocks, 'document')).toBe(false)
    expect(pipelineAllowedForManualStart(build, noFrame, blocks, 'review')).toBe(false)
    expect(pipelineAllowedForManualStart(build, noFrame, blocks, 'feature')).toBe(true)
    // A review pipeline is offered to a review task and hidden from a document task.
    const review = pipeline({ purpose: 'review' })
    expect(pipelineAllowedForManualStart(review, noFrame, blocks, 'review')).toBe(true)
    expect(pipelineAllowedForManualStart(review, noFrame, blocks, 'document')).toBe(false)
    // No task type supplied ⇒ no task-type restriction.
    expect(pipelineAllowedForManualStart(build, noFrame, blocks)).toBe(true)
  })

  it('still excludes recurring-only pipelines regardless of task type', () => {
    const recurring = pipeline({ purpose: 'document', availability: 'recurring' })
    expect(pipelineAllowedForManualStart(recurring, noFrame, blocks, 'document')).toBe(false)
  })
})

describe('pipelineAllowedForSchedule', () => {
  const noFrame = undefined
  const blocks: Block[] = []

  it('keeps an ordinary build pipeline and drops a one-off-only one', () => {
    expect(pipelineAllowedForSchedule(pipeline({ purpose: 'build' }), noFrame, blocks)).toBe(true)
    const oneOff = pipeline({ purpose: 'build', availability: 'one-off' })
    expect(pipelineAllowedForSchedule(oneOff, noFrame, blocks)).toBe(false)
  })

  it('drops the planning presets, which nothing else keeps out of this picker', () => {
    // A schedule seeds a `level: 'task'` block on every fire, so the engine refuses a planning
    // pipeline exactly as it would on a manual start — and the planning presets carry no
    // `availability`, so the one-off filter above never touched them. Worse than the manual case
    // because a schedule fires unattended: nobody sees the refusal, the work just stops happening.
    expect(pipelineAllowedForSchedule(pipeline({ purpose: 'planning' }), noFrame, blocks)).toBe(
      false,
    )
  })
})
