import { describe, expect, it } from 'vitest'
import { pipelineAllowedForTaskType, purposeAllowsAgentCategory } from '@cat-factory/contracts'
import type { Block, Pipeline } from '~/types/domain'
import {
  pipelineAllowedForManualStart,
  pipelineDisplaySteps,
  pipelineGateCount,
} from '~/utils/pipeline'

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
    // An unclassified pipeline is hidden from a document task (it requires the explicit classifier).
    expect(pipelineAllowedForTaskType(pipeline({ purpose: undefined }), 'document')).toBe(false)
  })

  it('a review task offers ONLY review-purpose pipelines', () => {
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'review' }), 'review')).toBe(true)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'build' }), 'review')).toBe(false)
    expect(pipelineAllowedForTaskType(pipeline({ purpose: 'document' }), 'review')).toBe(false)
    // An unclassified pipeline is hidden from a review task (it requires the explicit classifier).
    expect(pipelineAllowedForTaskType(pipeline({ purpose: undefined }), 'review')).toBe(false)
  })

  it('every other task type is unrestricted (any purpose, and undefined type)', () => {
    for (const type of ['feature', 'bug', 'spike', 'ralph', undefined] as const) {
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'build' }), type)).toBe(true)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'document' }), type)).toBe(true)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: 'review' }), type)).toBe(true)
      expect(pipelineAllowedForTaskType(pipeline({ purpose: undefined }), type)).toBe(true)
    }
  })
})

describe('purposeAllowsAgentCategory (builder palette gate)', () => {
  it('a build (or unclassified) pipeline may use every category', () => {
    for (const purpose of ['build', null, undefined] as const) {
      for (const cat of ['review', 'design', 'build', 'test', 'docs', 'gates'] as const) {
        expect(purposeAllowsAgentCategory(purpose, cat)).toBe(true)
      }
    }
  })

  it('a non-build pipeline hides the Implementation (build) and Testing (test) categories', () => {
    for (const purpose of ['document', 'review', 'research', 'planning'] as const) {
      expect(purposeAllowsAgentCategory(purpose, 'build')).toBe(false)
      expect(purposeAllowsAgentCategory(purpose, 'test')).toBe(false)
      // Non-code categories stay visible.
      expect(purposeAllowsAgentCategory(purpose, 'docs')).toBe(true)
      expect(purposeAllowsAgentCategory(purpose, 'review')).toBe(true)
      expect(purposeAllowsAgentCategory(purpose, 'gates')).toBe(true)
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
