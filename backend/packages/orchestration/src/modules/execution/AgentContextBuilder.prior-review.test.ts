import { describe, expect, it } from 'vitest'
import type {
  AgentJobHandle,
  Block,
  ExecutionInstance,
  PipelineStep,
  PrReviewStepState,
} from '@cat-factory/kernel'
import { InitiativePresetRegistry } from '@cat-factory/kernel'
import { defaultAgentKindRegistry, PR_PRIOR_REVIEW_CONTEXT_FILE } from '@cat-factory/agents'
import { AgentContextBuilder } from './AgentContextBuilder.js'
import { recordDispatchAttribution } from './step-fold.logic.js'

// A RESUMED PR review is handed the previous attempt's finished slice reports as
// `.cat-context/pr-prior-review.md`. The BUILDER emits it rather than a preOp beside the reviewer's
// other three, because the state rides the STEP (which a RepoOpContext deliberately does not carry)
// and because a preOp only runs once a run repo resolves — which this file must not depend on, or a
// deployment with no wired repo context would silently turn every resume back into a from-zero
// re-review. These pin that behaviour and the gates around it.

const TASK = {
  id: 'task_1',
  title: 'Review PR 4797',
  type: 'service',
  description: '',
  level: 'task',
  parentId: null,
} as unknown as Block

function review(over: Partial<PrReviewStepState> = {}): PrReviewStepState {
  return {
    status: 'reviewing',
    summary: null,
    slices: [],
    sliceReviews: [],
    resumeAttempts: 0,
    findings: [],
    selectedFindingIds: [],
    resolution: null,
    prUrl: null,
    model: null,
    reviewedHeadSha: null,
    postReport: null,
    postedFindingIds: [],
    postedBody: false,
    ...over,
  }
}

function step(agentKind: string, prReview?: PrReviewStepState): PipelineStep {
  return { agentKind, state: 'running', progress: 0, prReview } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: TASK.id,
    pipelineName: 'Review',
    status: 'running',
    currentStep: 0,
    steps,
  } as unknown as ExecutionInstance
}

async function contextFor(s: PipelineStep, dispatchKind?: string) {
  const builder = new AgentContextBuilder({
    workspaceRepository: { get: async () => null } as never,
    blockRepository: { get: async () => TASK } as never,
    accountRepository: { get: async () => null } as never,
    agentKindRegistry: defaultAgentKindRegistry(),
    initiativePresetRegistry: new InitiativePresetRegistry(),
  })
  return builder.buildContext(
    'ws1',
    instance([s]),
    s,
    true,
    TASK,
    dispatchKind ? { agentKind: dispatchKind } : undefined,
  )
}

describe('AgentContextBuilder prior-review context', () => {
  it('injects the prior reports and the remaining slices on a resumed review', async () => {
    const context = await contextFor(
      step(
        'pr-reviewer',
        review({
          resumeAttempts: 1,
          resumePendingSlices: ['infra-logging'],
          sliceReviews: [
            { label: 'api-correlation', status: 'completed', report: 'Found an N+1.' },
            { label: 'infra-logging', status: 'in_progress', report: null },
          ],
        }),
      ),
    )
    const file = context.injectedContextFiles?.find((f) => f.path === PR_PRIOR_REVIEW_CONTEXT_FILE)
    expect(file).toBeDefined()
    expect(file!.content).toContain('Found an N+1.')
    expect(file!.content).toContain('- infra-logging')
  })

  it('injects nothing for a review nobody resumed, so a fresh run is byte-for-byte unchanged', async () => {
    // `resumePendingSlices` being ABSENT is the whole signal. A fresh review can already carry
    // captured slice reports (the harness publishes them as it goes) and must NOT be told it is
    // continuing something.
    const context = await contextFor(
      step(
        'pr-reviewer',
        review({
          sliceReviews: [{ label: 'api', status: 'completed', report: 'body' }],
        }),
      ),
    )
    expect(context.injectedContextFiles).toBeUndefined()
  })

  it('injects for a resume whose every planned slice already reported (aggregation-only)', async () => {
    // An EMPTY pending list is a real resume — the incident's exact shape, where all slices
    // reported and the aggregation wedged — and must be distinguished from absent.
    const context = await contextFor(
      step(
        'pr-reviewer',
        review({
          resumeAttempts: 1,
          resumePendingSlices: [],
          sliceReviews: [{ label: 'api', status: 'completed', report: 'body' }],
        }),
      ),
    )
    const file = context.injectedContextFiles?.find((f) => f.path === PR_PRIOR_REVIEW_CONTEXT_FILE)
    expect(file?.content).toContain('No slice is left to review')
  })

  it('withholds it from a helper dispatched off the same step under another kind', async () => {
    // `fix` / `post` / `challenge` reuse the reviewer's step under an overriding kind and none of
    // them aggregates anything, so the prior reports would be pure carry charged on every turn.
    const context = await contextFor(
      step(
        'pr-reviewer',
        review({
          status: 'fixing',
          resumeAttempts: 1,
          resumePendingSlices: ['infra'],
          sliceReviews: [{ label: 'api', status: 'completed', report: 'body' }],
        }),
      ),
      'fixer',
    )
    expect(context.injectedContextFiles).toBeUndefined()
  })

  it('gives a resumed dispatch a non-zero epoch so it cannot re-attach to the wedged job', async () => {
    // The whole premise of a resume is that the previous job is WEDGED, so re-attaching to it —
    // which is what a container-reusing transport does for a known job id — would hand the
    // "recovery" straight back to the stuck run. The epoch comes off the run's own record of what
    // it has dispatched, so the reviewer needs no resume counter of its own for that to hold.
    const wedged = step(
      'pr-reviewer',
      review({ resumeAttempts: 2, resumePendingSlices: ['infra'] }),
    )
    for (let i = 0; i < 2; i++) {
      recordDispatchAttribution(wedged, { jobId: 'job_1' } as AgentJobHandle, 'pr-reviewer')
    }
    const context = await contextFor(wedged)
    expect(context.dispatchEpoch).toBe(2)
  })
})
