import type {
  AgentContextRecorder,
  AgentRunContext,
  ModelProvider,
  ModelRef,
  RecordAgentContextInput,
} from '@cat-factory/kernel'
import { AiAgentExecutor } from '@cat-factory/agents'
import { MockLanguageModelV3 } from 'ai/test'
import { describe, expect, it } from 'vitest'

// `agent_context_snapshots` had exactly one producer, the CONTAINER executor, so every inline
// AGENT KIND was absent from it: on a real board the table held rows for `architect`, `coder`,
// `initiative-analyst` and `reviewer`, and nothing for `architect-companion`. That is what these
// assert is closed, at the seam the facades wire, since the hole was never in the recorder's logic
// but in nobody calling it.
//
// What keeps a facade from re-opening it is not a test but the TYPE: `agentContextRecorder` is a
// required key with a nullable value, so a facade that wires no recorder has to say `undefined`
// (as the benchmark harness does) and one that simply forgets fails to compile. The services that
// call `generateText` directly rather than through a kind dispatch — the judges, the requirements
// reviewer, Kaizen's own grader — still file nothing; see `inline-context-record.ts`.

const REF: ModelRef = { provider: 'anthropic', model: 'claude-opus-5' }

function recordingRecorder(): {
  recorder: AgentContextRecorder
  recorded: RecordAgentContextInput[]
} {
  const recorded: RecordAgentContextInput[] = []
  return {
    recorder: {
      record: async (input) => {
        recorded.push(input)
      },
    },
    recorded,
  }
}

function executorWith(
  recorder: AgentContextRecorder | undefined,
  opts: { failCall?: boolean; ref?: ModelRef; runsInline?: boolean } = {},
) {
  const ref = opts.ref ?? REF
  const provider: ModelProvider = {
    resolve: () =>
      new MockLanguageModelV3({
        doGenerate: async () => {
          if (opts.failCall) throw new Error('upstream refused')
          return {
            content: [{ type: 'text' as const, text: 'ok' }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          }
        },
      }) as unknown as ReturnType<ModelProvider['resolve']>,
  }
  return new AiAgentExecutor({
    modelProvider: provider,
    agentRouting: { default: { ref }, byKind: {} },
    resolveBlockModel: () => undefined,
    agentContextRecorder: recorder,
    ...(opts.runsInline ? { runsInline: () => true } : {}),
  })
}

function context(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'architect-companion' as AgentRunContext['agentKind'],
    pipelineName: 'Standard build',
    stepIndex: 3,
    isFinalStep: false,
    workspaceId: 'ws1',
    executionId: 'exec_1',
    block: {
      title: 'A task',
      type: 'service',
      description: 'Do the thing',
      resolvedFragments: [{ id: 'frg_naming', body: 'Name things well.' }],
    },
    priorOutputs: [],
    decisions: [{ question: 'Queue or cron?', chosen: 'Queue' }],
    resolvedDecision: null,
    ...over,
  } as AgentRunContext
}

describe('an inline agent dispatch', () => {
  it('records the composed prompts, the folded fragments and the step it belongs to', async () => {
    const { recorder, recorded } = recordingRecorder()
    await executorWith(recorder).run(context())

    expect(recorded).toHaveLength(1)
    const snapshot = recorded[0]!
    expect(snapshot).toMatchObject({
      workspaceId: 'ws1',
      executionId: 'exec_1',
      agentKind: 'architect-companion',
      // The stepIndex is what `KaizenService.snapshotForStep` matches on, so a run with the same
      // kind in two steps still grades the right one.
      stepIndex: 3,
      model: 'anthropic:claude-opus-5',
      // Null, not `pi`: an ordinary inline call is served by an HTTP provider, not a harness.
      harness: null,
    })
    expect(snapshot.systemPrompt).not.toBe('')
    expect(snapshot.userPrompt).toContain('A task')
    expect(snapshot.fragments).toEqual([{ id: 'frg_naming', body: 'Name things well.' }])
    expect(snapshot.extras).toMatchObject({
      pipelineName: 'Standard build',
      mode: 'inline',
      decisions: [{ question: 'Queue or cron?', chosen: 'Queue' }],
    })
  })

  it('records the REWORK it is answering, so a rework round is not read as a first pass', async () => {
    // The container projection has always carried this, and it is where a stalled-companion
    // investigation starts: without it, a snapshot of round three is indistinguishable from a
    // snapshot of round one. The feedback verbatim plus the FACT of a prior proposal — not the
    // proposal itself, which is the previous dispatch's own snapshot.
    const { recorder, recorded } = recordingRecorder()
    await executorWith(recorder).run(
      context({
        revision: {
          previousProposal: 'the first design',
          feedback: 'name the queue',
          requestedBy: 'reviewer',
        },
      } as Partial<AgentRunContext>),
    )
    expect(recorded[0]!.extras).toMatchObject({
      revision: { feedback: 'name the queue', hadPriorProposal: true },
    })
  })

  it('omits the revision entirely on a first pass, rather than recording an empty one', async () => {
    const { recorder, recorded } = recordingRecorder()
    await executorWith(recorder).run(context())
    expect(recorded[0]!.extras).not.toHaveProperty('revision')
  })

  it('records an EMPTY context-file list rather than omitting the field', async () => {
    // An inline call has no checkout and injects no `.cat-context` files, so empty is the honest
    // answer and a reader can verify it against the prompts beside it. Absent would read as
    // "unknown", which is the state this whole change exists to stop conflating with a fact.
    const { recorder, recorded } = recordingRecorder()
    await executorWith(recorder).run(context())
    expect(recorded[0]!.contextFiles).toEqual([])
  })

  it('records the context of a call that THREW, which is the one worth reading', async () => {
    const { recorder, recorded } = recordingRecorder()
    await expect(executorWith(recorder, { failCall: true }).run(context())).rejects.toThrow(
      'upstream refused',
    )
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.agentKind).toBe('architect-companion')
  })

  it('names the harness when the deployment serves the ref by driving a CLI', async () => {
    const { recorder, recorded } = recordingRecorder()
    await executorWith(recorder, {
      ref: { provider: 'anthropic', model: 'claude-opus-5', harness: 'claude-code' },
      runsInline: true,
    }).run(context())
    expect(recorded[0]!.harness).toBe('claude-code')
  })

  it('records nothing for a dispatch with no run to file it under', async () => {
    // The benchmark harness builds this executor outside any run. A snapshot keyed to no
    // execution would be unreachable from every run-scoped read.
    const { recorder, recorded } = recordingRecorder()
    await executorWith(recorder).run(
      context({ workspaceId: undefined, executionId: undefined } as Partial<AgentRunContext>),
    )
    expect(recorded).toEqual([])
  })

  it('runs unchanged with no recorder wired', async () => {
    const result = await executorWith(undefined).run(context())
    expect(result.output).toBe('ok')
  })

  it('never fails the dispatch when the recorder throws', async () => {
    const recorder: AgentContextRecorder = {
      record: async () => {
        throw new Error('telemetry store unreachable')
      },
    }
    const result = await executorWith(recorder).run(context())
    expect(result.output).toBe('ok')
  })
})
