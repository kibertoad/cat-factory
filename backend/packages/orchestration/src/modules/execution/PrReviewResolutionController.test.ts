import { describe, expect, it } from 'vitest'
import type {
  AgentRunContext,
  AgentRunResult,
  Block,
  CreateReviewInput,
  ExecutionInstance,
  PipelineStep,
  PrReviewFinding,
  PrReviewStepState,
  RepoFiles,
} from '@cat-factory/kernel'
import { FIXER_AGENT_KIND } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import { PrReviewResolutionController } from './PrReviewResolutionController.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepHandlerContext } from './step-handler-registry.js'

// The driver half of a `post` resolution that queued findings for the Fixer. What these pin is
// the ORDERING and the replay story: the comments land first, the `fixing` status is persisted
// before the Fixer is dispatched, a replay after the post marker was consumed continues to the
// Fixer instead of settling `done`, and a partial post never leaves a queue behind to fire later.

const finding = (id: string, path: string, line: number | null): PrReviewFinding => ({
  id,
  sliceId: null,
  path,
  line,
  side: line == null ? null : 'RIGHT',
  severity: 'high',
  category: 'correctness',
  title: `Finding ${id}`,
  detail: 'detail',
  suggestedFix: null,
})

const FINDINGS = [
  finding('prf_post', 'src/a.ts', 3),
  finding('prf_fix', 'src/b.ts', 7),
  finding('prf_skip', 'src/c.ts', 9),
]

const BLOCK = {
  id: 'task_review',
  title: 'Review PR #42',
  taskTypeFields: { prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' },
} as unknown as Block

function postingReview(over: Partial<PrReviewStepState> = {}): PrReviewStepState {
  return {
    status: 'posting',
    summary: null,
    slices: [],
    sliceReviews: [],
    resumeAttempts: 0,
    findings: FINDINGS,
    selectedFindingIds: ['prf_post'],
    fixFindingIds: ['prf_fix'],
    resolution: 'post',
    prUrl: 'https://github.com/o/r/pull/42',
    model: null,
    reviewedHeadSha: null,
    postReport: null,
    postedFindingIds: [],
    postedBody: false,
    postAttempts: 1,
    ...over,
  }
}

interface Recorder {
  /** The review status at each persist, in order. */
  persistedStatuses: string[]
  posted: CreateReviewInput[]
  dispatched: { kind: string | undefined; context: AgentRunContext; persistedBefore: number }[]
  recorded: AgentRunResult[]
  parked: number
}

function harness(options: { failPaths?: string[] } = {}) {
  const rec: Recorder = {
    persistedStatuses: [],
    posted: [],
    dispatched: [],
    recorded: [],
    parked: 0,
  }
  const repo = {
    pullRequestHeadRef: async () => 'feature/pr-42',
    createReview: async (_number: number, input: CreateReviewInput) => {
      rec.posted.push(input)
      const fail = new Set(options.failPaths ?? [])
      return {
        comments: input.comments.map((c) =>
          fail.has(c.path)
            ? { posted: false, error: 'Line could not be resolved' }
            : { posted: true },
        ),
        bodyPosted: input.body ? true : null,
      }
    },
  } as unknown as RepoFiles
  let current: PipelineStep | undefined
  const controller = new PrReviewResolutionController({
    runStateMachine: {
      casPersist: async () => {
        rec.persistedStatuses.push(current?.prReview?.status ?? '')
      },
      parkStepOnDecision: async (): Promise<AdvanceResult> => {
        rec.parked++
        return { kind: 'awaiting_decision', decisionId: 'apr_1' }
      },
    } as unknown as RunStateMachine,
    resolveRunRepoContext: async () => ({ repo, baseBranch: 'main', repoId: 'repo_1' }),
    runInitiatorScope: (_scope, fn) => fn(),
    recordStepResult: async (_ws, _inst, _step, _final, result): Promise<AdvanceResult> => {
      rec.recorded.push(result)
      return { kind: 'continue' }
    },
    handleAgentStep: async (ctx, kind, augment): Promise<AdvanceResult> => {
      const context = {
        block: { ...ctx.block },
        priorOutputs: [],
        aprioriBranches: [],
      } as unknown as AgentRunContext
      augment?.(context)
      rec.dispatched.push({ kind, context, persistedBefore: rec.persistedStatuses.length })
      return { kind: 'awaiting_job', jobId: 'job_fix', stepIndex: 0 }
    },
  })
  const run = (step: PipelineStep): Promise<AdvanceResult> => {
    current = step
    const ctx: StepHandlerContext = {
      workspaceId: 'ws_1',
      instance: { id: 'exec_1', steps: [step], initiatedBy: null } as unknown as ExecutionInstance,
      step,
      block: BLOCK,
      isFinalStep: true,
      options: {},
    }
    return controller.handle(ctx)
  }
  return { rec, run }
}

const reviewStep = (review: PrReviewStepState, marker: boolean): PipelineStep =>
  ({
    agentKind: 'pr-reviewer',
    state: 'running',
    jobId: null,
    prReview: review,
    pendingPrReviewPost: marker,
  }) as unknown as PipelineStep

describe('PrReviewResolutionController: post, then fix', () => {
  it('posts the comments, persists `fixing`, then dispatches the Fixer with only the queued findings', async () => {
    const { rec, run } = harness()
    const step = reviewStep(postingReview(), true)

    const result = await run(step)

    // One post, carrying the comment finding and never the one queued for the fixer.
    expect(rec.posted).toHaveLength(1)
    expect(rec.posted[0]!.comments.map((c) => c.path)).toEqual(['src/a.ts'])
    // The marker was consumed, then `fixing` was persisted, both BEFORE the dispatch: a replay
    // from here routes to the fixer by status and cannot re-enter the post.
    expect(rec.persistedStatuses).toEqual(['posting', 'fixing'])
    expect(rec.dispatched).toHaveLength(1)
    expect(rec.dispatched[0]!.persistedBefore).toBe(2)
    expect(rec.dispatched[0]!.kind).toBe(FIXER_AGENT_KIND)
    const feedback = rec.dispatched[0]!.context.priorOutputs.at(-1)!.output
    expect(feedback).toContain('src/b.ts:7')
    expect(feedback).not.toContain('src/a.ts')
    expect(feedback).not.toContain('src/c.ts')
    expect(rec.dispatched[0]!.context.aprioriBranches).toEqual([
      { name: 'feature/pr-42', mode: 'working' },
    ])
    // The step did not settle: the fixer's completion does that.
    expect(rec.recorded).toHaveLength(0)
    expect(result.kind).toBe('awaiting_job')
    expect(step.prReview?.status).toBe('fixing')
    expect(step.prReview?.postedFindingIds).toEqual(['prf_post'])
    expect(step.prReview?.postReport?.posted).toBe(1)
  })

  it('finishes `done` as before when nothing is queued for the fixer', async () => {
    const { rec, run } = harness()
    const step = reviewStep(postingReview({ fixFindingIds: [] }), true)

    await run(step)

    expect(rec.dispatched).toHaveLength(0)
    expect(rec.recorded).toHaveLength(1)
    expect(step.prReview?.status).toBe('done')
  })

  it('re-parks a PARTIAL post with the fixer queue cleared, dispatching nothing', async () => {
    const { rec, run } = harness({ failPaths: ['src/a.ts'] })
    const step = reviewStep(postingReview(), true)

    await run(step)

    expect(rec.dispatched).toHaveLength(0)
    expect(rec.parked).toBe(1)
    expect(step.prReview?.status).toBe('awaiting_selection')
    expect(step.prReview?.resolution).toBeNull()
    // Cleared so a later pass cannot fire a fix the curator never re-confirmed.
    expect(step.prReview?.fixFindingIds).toEqual([])
  })

  it('continues to the Fixer on a replay after the post marker was consumed, without re-posting', async () => {
    // The winning attempt consumed the marker and posted, then died before persisting `fixing`.
    const { rec, run } = harness()
    const step = reviewStep(postingReview({ postedFindingIds: ['prf_post'] }), false)

    await run(step)

    expect(rec.posted).toHaveLength(0)
    expect(rec.persistedStatuses).toEqual(['fixing'])
    expect(rec.dispatched).toHaveLength(1)
    expect(rec.dispatched[0]!.kind).toBe(FIXER_AGENT_KIND)
    expect(rec.recorded).toHaveLength(0)
    expect(step.prReview?.status).toBe('fixing')
  })

  it('routes a replay that already persisted `fixing` straight to the Fixer', async () => {
    const { rec, run } = harness()
    const step = reviewStep(
      postingReview({ status: 'fixing', postedFindingIds: ['prf_post'] }),
      false,
    )

    await run(step)

    expect(rec.posted).toHaveLength(0)
    expect(rec.dispatched).toHaveLength(1)
    const feedback = rec.dispatched[0]!.context.priorOutputs.at(-1)!.output
    expect(feedback).toContain('src/b.ts:7')
    expect(feedback).not.toContain('src/a.ts')
  })
})
