import { describe, expect, it } from 'vitest'
import {
  agentCategorySchema,
  isAgentCategory,
  isPipelinePurpose,
  PIPELINE_PURPOSES,
  pipelineAllowedForBlockLevel,
  pipelineAllowedForTaskType,
  purposeAllowsAgentCategory,
  purposeSuggestsAgentCategory,
} from '@cat-factory/contracts'
import type { Block, Pipeline } from '~/types/domain'
import {
  pipelineAllowedForManualStart,
  pipelineAllowedForSchedule,
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
      { kind: 'task-estimator', gated: false },
      { kind: 'coder', gated: true },
      { kind: 'reviewer', gated: false },
    ])
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
  it('a build pipeline, and one whose classifier this build cannot name, may use every category', () => {
    for (const purpose of ['build', UNKNOWN_PURPOSE] as const) {
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
  it('offers the whole catalog to a build pipeline, and to one it cannot name', () => {
    for (const purpose of ['build', UNKNOWN_PURPOSE] as const) {
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
