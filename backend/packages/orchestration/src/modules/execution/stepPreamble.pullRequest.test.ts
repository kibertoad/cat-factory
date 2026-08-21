import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import { runStepPreamble, type StepPreambleDeps } from './stepPreamble.js'

// The PULL-REQUEST precondition half of the pre-dispatch preamble.
//
// A `clone.prHead` + `clone.requirePr` kind READS a pull request, and both of the other
// dispositions are wrong for it: dispatching hands it a base checkout it would score as though it
// were the change, and failing the dispatch ends a run whose work has already shipped over a
// reading nothing gates on. So it is SKIPPED here, before anything is spun up, with the reason on
// the step. Driven through `runStepPreamble` for the reason the condition tests are: what matters
// is the disposition and that it goes through the SAME skip door the estimate gate uses.

const WS = 'ws_1'
const REGISTRY = defaultAgentKindRegistry()

function step(agentKind: string): PipelineStep {
  return {
    agentKind,
    state: 'working',
    progress: 0,
    decision: null,
    requiresApproval: false,
    approval: null,
  } as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    pipelineId: 'pl_build',
    pipelineName: 'Standard build',
    steps,
    currentStep: 0,
    status: 'running',
    createdAt: 0,
  } as ExecutionInstance
}

type SkipSpy = ReturnType<typeof vi.fn<StepPreambleDeps['skipGatedStep']>>

function deps(block: Block): { deps: StepPreambleDeps; skipGatedStep: SkipSpy } {
  const skipGatedStep: SkipSpy = vi.fn<StepPreambleDeps['skipGatedStep']>(
    async () => ({ kind: 'noop' }) as never,
  )
  return {
    skipGatedStep,
    deps: {
      spend: { isOverBudget: async () => false },
      accountOf: async () => null,
      currentStepIsNonMetered: async () => false,
      skipGatedStep,
      blockOf: async () => block,
      stateMachine: { persistAndEmit: async () => {} } as never,
      stepGraph: { startStep: () => {} } as never,
      inputGate: { evaluate: async () => null } as never,
      agentKindRegistry: REGISTRY,
      serviceScopeOf: async () => ({ frontend: false, backend: true }),
    },
  }
}

const task = (over: Partial<Block> = {}): Block =>
  ({ id: 'blk_1', level: 'task', ...over }) as Block

describe('runStepPreamble — the pull-request precondition', () => {
  it('skips a reader whose run opened no pull request, naming the reason', async () => {
    const { deps: d, skipGatedStep } = deps(task())
    const s = step('task-reassessor')
    const outcome = await runStepPreamble(d, WS, instance([s]), s)
    expect(outcome.kind).toBe('stop')
    expect(skipGatedStep).toHaveBeenCalledTimes(1)
    // A skip nothing else on the step explains has to say why: the SPA maps this member to copy,
    // so the engine commits no prose to a single language.
    expect(skipGatedStep.mock.calls[0]?.[4]).toBe('no_pull_request')
  })

  it('proceeds once the run has opened one', async () => {
    const { deps: d, skipGatedStep } = deps(
      task({ pullRequest: { url: 'u', number: 7, branch: 'feat/x' } } as Partial<Block>),
    )
    const s = step('task-reassessor')
    expect((await runStepPreamble(d, WS, instance([s]), s)).kind).toBe('proceed')
    expect(skipGatedStep).not.toHaveBeenCalled()
  })

  it('reads the source the KIND declared, not whichever pull request happens to be around', async () => {
    // The reassessor declares `prHeadSource: 'run'`, so a PR the TASK names is not its subject and
    // does not stand in for the one the run never opened. The mirror case is the reviewer below.
    const { deps: d, skipGatedStep } = deps(
      task({ taskTypeFields: { prNumber: 4558 } } as Partial<Block>),
    )
    const s = step('task-reassessor')
    expect((await runStepPreamble(d, WS, instance([s]), s)).kind).toBe('stop')
    expect(skipGatedStep.mock.calls[0]?.[4]).toBe('no_pull_request')
  })

  it('says nothing about a reader that declares no precondition', async () => {
    // The `pr-reviewer` sets `prHead` WITHOUT `requirePr`: an unresolvable number degrades to no
    // prefetch and the review works from its injected diff, which is a dispatch rather than a skip.
    const { deps: d, skipGatedStep } = deps(task())
    const s = step('pr-reviewer')
    expect((await runStepPreamble(d, WS, instance([s]), s)).kind).toBe('proceed')
    expect(skipGatedStep).not.toHaveBeenCalled()
  })

  it('says nothing about a WRITER that requires a pull request', async () => {
    // The in-place fixers declare `requirePr` on a `pr` clone: with no PR they must FAIL, because
    // cloning base would push unrelated work onto it. That refusal stays at the dispatch.
    const { deps: d, skipGatedStep } = deps(task())
    const s = step('ci-fixer')
    expect((await runStepPreamble(d, WS, instance([s]), s)).kind).toBe('proceed')
    expect(skipGatedStep).not.toHaveBeenCalled()
  })
})
