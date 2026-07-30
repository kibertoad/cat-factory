import { generateText } from 'ai'
import { describe, expect, it } from 'vitest'
import { catFactoryObservability, createRecordingLogger } from '@cat-factory/kernel'
import type { HarnessCallMetric, InlineLlmCall } from '@cat-factory/kernel'
import {
  CliInlineLanguageModel,
  reportsOwnLlmCalls,
  type InlineCliRequest,
  type InlineCliTelemetry,
} from './cli-inline.js'

// The CLI-backed inline LanguageModel adapts an injected one-shot runner (the developer's
// ambient claude/codex CLI, in local mode) to the AI SDK, so the inline services keep calling
// `generateText` unchanged. These assert the mapping: prompt in → runner → text/usage out.
//
// And the telemetry, which is the part that cannot be delegated upwards: one `doGenerate` here is
// a whole CLI tool loop, so the middleware wrapped around it could only ever report ONE call, only
// after the subprocess exited, and zeros whenever it was killed. This model therefore files its
// own rows and stands the middleware down — so what it files is the only account a run gets.

/** A recorder that captures the rows the model files, in order. */
function captureRecorder(): { rows: InlineLlmCall[]; telemetry: InlineCliTelemetry } {
  const rows: InlineLlmCall[] = []
  return {
    rows,
    telemetry: {
      recordCall: async (call) => {
        rows.push(call)
      },
      scope: { workspaceId: 'ws_scope', executionId: 'exec_scope' },
    },
  }
}

/** One call as a harness CLI reports it off its event stream. */
function reported(over: Partial<HarnessCallMetric> = {}): HarnessCallMetric {
  return {
    promptText: '[{"role":"user","content":"go"}]',
    messageCount: 1,
    responseText: 'turn text',
    reasoningText: '',
    inputTokens: 10,
    cacheReadTokens: 900,
    cacheWriteTokens: 90,
    outputTokens: 5,
    finishReason: 'tool_use',
    ...over,
  }
}

/** Let the fire-and-forget recorder dispatches land (they are never awaited by the call). */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('CliInlineLanguageModel', () => {
  it('flattens system + user prompt, runs the CLI runner, and returns its text', async () => {
    const seen: InlineCliRequest[] = []
    const model = new CliInlineLanguageModel('anthropic', 'claude-opus-4-8', async (req) => {
      seen.push(req)
      return {
        text: 'REVIEW OK',
        finishReason: 'stop',
        usage: { inputTokens: 12, outputTokens: 3 },
      }
    })

    const result = await generateText({
      model,
      system: 'You are a reviewer.',
      prompt: 'Review this task.',
    })

    expect(result.text).toBe('REVIEW OK')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.model).toBe('claude-opus-4-8')
    expect(seen[0]!.system).toContain('You are a reviewer.')
    expect(seen[0]!.prompt).toContain('Review this task.')
  })

  it('surfaces a length finish reason (so the reviewer can reject a truncated doc)', async () => {
    const model = new CliInlineLanguageModel('anthropic', 'claude-opus-4-8', async () => ({
      text: 'partial…',
      finishReason: 'length',
    }))
    const result = await generateText({ model, prompt: 'go' })
    expect(result.finishReason).toBe('length')
  })

  it('propagates a runner failure to the caller', async () => {
    const model = new CliInlineLanguageModel('anthropic', 'claude-opus-4-8', () =>
      Promise.reject(new Error('claude exited with code 1')),
    )
    await expect(generateText({ model, prompt: 'go' })).rejects.toThrow(/claude exited/)
  })

  describe('per-call telemetry', () => {
    // The marker is what the instrumentation middleware reads to decide who owns this model's
    // rows. Wired to whether a recorder exists rather than hard-coded true: with no metric store
    // this model has nothing to file, and standing the middleware down would then lose the one
    // aggregate generation a sink-only deployment does get.
    it('claims its own calls only when a recorder is wired', () => {
      const run = async () => ({ text: 'ok' })
      expect(reportsOwnLlmCalls(new CliInlineLanguageModel('anthropic', 'm', run))).toBe(false)
      expect(
        reportsOwnLlmCalls(
          new CliInlineLanguageModel('anthropic', 'm', run, captureRecorder().telemetry),
        ),
      ).toBe(true)
    })

    it('files one row per reported call, in turn order, with the classes kept apart', async () => {
      const { rows, telemetry } = captureRecorder()
      const model = new CliInlineLanguageModel(
        'anthropic',
        'claude-opus-4-8',
        async (req) => {
          req.reportCall?.(reported({ responseText: 'first' }))
          req.reportCall?.(reported({ responseText: 'second', outputTokens: 7 }))
          return { text: 'done', usage: { inputTokens: 10, outputTokens: 12 } }
        },
        telemetry,
      )

      await generateText({
        model,
        prompt: 'go',
        providerOptions: catFactoryObservability({
          agentKind: 'doc-researcher',
          workspaceId: 'ws_1',
          executionId: 'exec_1',
        }),
      })
      await settle()

      // Exactly the calls the CLI made — no extra aggregate row, which would double every token
      // of the step in its rollup.
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.turnIndex)).toEqual([0, 1])
      expect(rows.map((r) => r.responseText())).toEqual(['first', 'second'])
      expect(rows[0]).toMatchObject({
        workspaceId: 'ws_1',
        executionId: 'exec_1',
        agentKind: 'doc-researcher',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        promptTokens: 10,
        cacheReadTokens: 900,
        cacheWriteTokens: 90,
        completionTokens: 5,
        totalTokens: 1005,
        finishReason: 'tool_use',
        ok: true,
        // The CLIs expose no per-call timing and apply their own output ceiling, so both are
        // stated as unknown rather than filled with this step's elapsed time / our ignored ask.
        durationMs: 0,
        requestMaxTokens: null,
        // The tools this loop used are the CLI's own; the request offered none.
        toolCount: 0,
      })
    })

    // Every first-party inline caller tags its call, but the scope is what makes attribution
    // unforgettable for one that does not — and a row filed under no run is worse than none: it
    // is IN the store and absent from every run-scoped read.
    it('falls back to the provider scope when the call carries no tag', async () => {
      const { rows, telemetry } = captureRecorder()
      const model = new CliInlineLanguageModel(
        'anthropic',
        'claude-opus-4-8',
        async (req) => {
          req.reportCall?.(reported())
          return { text: 'done' }
        },
        telemetry,
      )
      await generateText({ model, prompt: 'go' })
      await settle()
      expect(rows[0]).toMatchObject({ workspaceId: 'ws_scope', executionId: 'exec_scope' })
    })

    // The whole point of reporting as they arrive: a killed run's completed turns are ALREADY on
    // record. What the failure adds is that the step died — one row, at the next ordinal, with no
    // tokens, because the call it stands for never got as far as reporting any. Before this, that
    // zeroed row was a killed step's ONLY row, and it read as a step that had spent nothing.
    it('keeps the completed calls and adds a zero-token failure row when the run dies', async () => {
      const { rows, telemetry } = captureRecorder()
      const model = new CliInlineLanguageModel(
        'anthropic',
        'claude-opus-4-8',
        async (req) => {
          req.reportCall?.(reported())
          req.reportCall?.(reported())
          throw new Error('claude timed out after 300000ms; burned 1.00M tokens across 2 calls')
        },
        telemetry,
      )

      await expect(generateText({ model, prompt: 'go' })).rejects.toThrow(/timed out/)
      await settle()

      expect(rows).toHaveLength(3)
      expect(rows.slice(0, 2).every((r) => r.ok && r.totalTokens === 1005)).toBe(true)
      expect(rows[2]).toMatchObject({
        turnIndex: 2,
        ok: false,
        totalTokens: 0,
        finishReason: null,
      })
      expect(rows[2]!.errorMessage).toMatch(/timed out after 300000ms/)
    })

    // `codex exec` prints its final message and narrates nothing, so nothing else will ever
    // account for the step. A CLI build that narrates turns but no per-turn usage lands here too:
    // its cumulative total arrives only on the terminal event.
    it('files one aggregate row when the CLI reported no call carrying tokens', async () => {
      const { rows, telemetry } = captureRecorder()
      const model = new CliInlineLanguageModel(
        'anthropic',
        'claude-opus-4-8',
        async (req) => {
          req.reportCall?.(
            reported({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }),
          )
          return {
            text: 'done',
            usage: { inputTokens: 40, cacheReadTokens: 400, outputTokens: 9 },
          }
        },
        telemetry,
      )
      await generateText({ model, prompt: 'go' })
      await settle()

      const aggregate = rows.find((r) => r.turnIndex === undefined)
      expect(aggregate).toMatchObject({
        promptTokens: 40,
        cacheReadTokens: 400,
        completionTokens: 9,
        totalTokens: 449,
        ok: true,
      })
    })

    // Telemetry never breaks the LLM work, and a row it cannot file is REPORTED rather than
    // dropped in silence — a null workspace here means the wiring changed and this model has
    // stood the middleware down for nothing.
    it('warns rather than throwing when there is no workspace to file under', async () => {
      const logger = createRecordingLogger()
      const model = new CliInlineLanguageModel(
        'anthropic',
        'claude-opus-4-8',
        async (req) => {
          req.reportCall?.(reported())
          return { text: 'done' }
        },
        {
          recordCall: () => Promise.reject(new Error('should never be called')),
          logger,
        },
      )
      const result = await generateText({ model, prompt: 'go' })
      await settle()
      expect(result.text).toBe('done')
      expect(logger.lines.map((l) => `${l.level}:${l.msg}`)).toEqual([
        expect.stringMatching(/^warn:.*no workspace/),
      ])
    })

    it('never lets a failing recorder reach the caller', async () => {
      const model = new CliInlineLanguageModel(
        'anthropic',
        'claude-opus-4-8',
        async (req) => {
          req.reportCall?.(reported())
          return { text: 'done' }
        },
        {
          recordCall: () => Promise.reject(new Error('store down')),
          scope: { workspaceId: 'ws_1' },
        },
      )
      const result = await generateText({ model, prompt: 'go' })
      await settle()
      expect(result.text).toBe('done')
    })
  })
})
