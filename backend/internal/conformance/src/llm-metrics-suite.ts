import type { HarnessCallMetric, LlmCallMetric, LlmCallMetricRepository } from '@cat-factory/kernel'
import { LlmObservabilityService, makeHarnessCallRecorder } from '@cat-factory/orchestration'
import { describe, expect, it } from 'vitest'

// Cross-runtime parity for the LLM observability sink. The proxy that records these
// metrics is runtime-neutral, but each facade persists them in its own store (D1 on
// Cloudflare, Drizzle/Postgres on Node). This suite drives the SAME record → list →
// summarize → prune assertions through whichever real repository a runtime hands it,
// so a column mapped differently or an aggregate computed differently fails a test
// instead of shipping. Both runtimes invoke it over their real database.

/** Build a fully-specified metric, overriding only what a case cares about. */
function metric(overrides: Partial<LlmCallMetric> & Pick<LlmCallMetric, 'id'>): LlmCallMetric {
  return {
    workspaceId: 'ws',
    executionId: 'exec',
    agentKind: 'coder',
    provider: 'workers-ai',
    model: 'm',
    createdAt: 1,
    streaming: false,
    messageCount: 2,
    toolCount: 1,
    requestMaxTokens: 1000,
    promptTokens: 100,
    cachedPromptTokens: 0,
    completionTokens: 50,
    totalTokens: 150,
    finishReason: 'stop',
    upstreamMs: 200,
    overheadMs: 30,
    totalMs: 230,
    ok: true,
    httpStatus: 200,
    errorMessage: null,
    promptText: '[]',
    promptPrefixCount: 0,
    promptHash: '',
    responseText: 'ok',
    reasoningText: '',
    ...overrides,
  }
}

/**
 * Assert a runtime's {@link LlmCallMetricRepository} behaves identically to the
 * others. `makeRepo` returns a repo over the runtime's real store; ids are unique
 * per run so the shared database stays isolated between cases.
 */
export function defineLlmMetricsSuite(name: string, makeRepo: () => LlmCallMetricRepository): void {
  describe(`[${name}] llm metrics repository parity`, () => {
    // Unique workspace/execution per case so the shared DB doesn't bleed across tests.
    let seq = 0
    const ids = () => {
      seq += 1
      const tag = `${name}-${seq}-${Math.floor(Math.random() * 1e9)}`
      return { ws: `ws-${tag}`, e1: `e1-${tag}`, e2: `e2-${tag}` }
    }

    it('records calls and lists them newest-first per execution', async () => {
      const repo = makeRepo()
      const { ws, e1, e2 } = ids()
      await repo.record(metric({ id: `${ws}-a`, workspaceId: ws, executionId: e1, createdAt: 10 }))
      await repo.record(metric({ id: `${ws}-b`, workspaceId: ws, executionId: e1, createdAt: 30 }))
      await repo.record(metric({ id: `${ws}-c`, workspaceId: ws, executionId: e1, createdAt: 20 }))
      await repo.record(metric({ id: `${ws}-d`, workspaceId: ws, executionId: e2, createdAt: 99 }))

      const calls = await repo.listByExecution(ws, e1)
      expect(calls.map((c) => c.id)).toEqual([`${ws}-b`, `${ws}-c`, `${ws}-a`])
      // The other execution's call is excluded.
      expect((await repo.listByExecution(ws, e2)).map((c) => c.id)).toEqual([`${ws}-d`])
      // Round-trips the full record (incl. the heavy text columns + nullable fields).
      const first = calls[0]!
      expect(first.responseText).toBe('ok')
      expect(first.streaming).toBe(false)
      expect(first.requestMaxTokens).toBe(1000)
    })

    it('round-trips the reasoning trace (a thinking model with empty response text)', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // The signature this column exists for: output tokens spent, but no response text —
      // the thinking trace is the only record of what those tokens produced.
      await repo.record(
        metric({
          id: `${ws}-r`,
          workspaceId: ws,
          executionId: e1,
          completionTokens: 17856,
          finishReason: 'stop',
          responseText: '',
          reasoningText: 'Let me work through the spec…',
        }),
      )
      const stored = (await repo.listByExecution(ws, e1))[0]!
      expect(stored.responseText).toBe('')
      expect(stored.reasoningText).toBe('Let me work through the spec…')
    })

    it('round-trips the delta prompt fields and reports the newest chain tip', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // No calls yet ⇒ no chain tip.
      expect(await repo.latestChainTip(ws, e1, 'coder')).toBeNull()

      await repo.record(
        metric({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          createdAt: 10,
          messageCount: 2,
          promptText: '[{"role":"system"},{"role":"user"}]',
          promptPrefixCount: 0,
          promptHash: 'h1',
        }),
      )
      await repo.record(
        metric({
          id: `${ws}-2`,
          workspaceId: ws,
          executionId: e1,
          createdAt: 20,
          messageCount: 4,
          promptText: '[{"role":"assistant"},{"role":"tool"}]',
          promptPrefixCount: 2,
          promptHash: 'h2',
        }),
      )

      // The tip is the newest call for the (ws, execution, kind) chain.
      expect(await repo.latestChainTip(ws, e1, 'coder')).toEqual({
        messageCount: 4,
        promptHash: 'h2',
      })
      // A different agent kind has its own (empty) chain.
      expect(await repo.latestChainTip(ws, e1, 'reviewer')).toBeNull()

      // The delta fields survive the round-trip.
      const stored = (await repo.listByExecution(ws, e1)).find((c) => c.id === `${ws}-2`)!
      expect(stored.promptPrefixCount).toBe(2)
      expect(stored.promptHash).toBe('h2')
      expect(stored.promptText).toBe('[{"role":"assistant"},{"role":"tool"}]')
    })

    it('summarizes per agent-kind: tokens, cached tokens, peak, headroom, truncation, errors, warnings', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // ok stop, truncated (length → warning), and a failed call — same agent kind.
      await repo.record(
        metric({
          id: `${ws}-1`,
          workspaceId: ws,
          executionId: e1,
          promptTokens: 100,
          cachedPromptTokens: 40,
          completionTokens: 50,
          requestMaxTokens: 1000,
          upstreamMs: 100,
          overheadMs: 10,
        }),
      )
      await repo.record(
        metric({
          id: `${ws}-2`,
          workspaceId: ws,
          executionId: e1,
          promptTokens: 100,
          cachedPromptTokens: 60,
          completionTokens: 990,
          requestMaxTokens: 1000,
          finishReason: 'length',
          upstreamMs: 200,
          overheadMs: 20,
        }),
      )
      await repo.record(
        metric({
          id: `${ws}-3`,
          workspaceId: ws,
          executionId: e1,
          ok: false,
          httpStatus: 502,
          finishReason: null,
          completionTokens: 0,
          upstreamMs: 5,
          overheadMs: 5,
        }),
      )

      const summaries = await repo.summarizeByExecution(ws, e1)
      expect(summaries).toHaveLength(1)
      const s = summaries[0]!
      expect(s.agentKind).toBe('coder')
      expect(s.calls).toBe(3)
      expect(s.cachedPromptTokens).toBe(100)
      expect(s.completionTokens).toBe(1040)
      expect(s.peakCompletionTokens).toBe(990)
      expect(s.maxOutputTokens).toBe(1000)
      expect(s.truncatedCalls).toBe(1)
      expect(s.errors).toBe(1)
      expect(s.warnings).toBe(1)
      expect(s.upstreamMs).toBe(305)
      expect(s.overheadMs).toBe(35)
    })

    it('groups summaries by agent kind', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      await repo.record(
        metric({ id: `${ws}-x`, workspaceId: ws, executionId: e1, agentKind: 'coder' }),
      )
      await repo.record(
        metric({ id: `${ws}-y`, workspaceId: ws, executionId: e1, agentKind: 'reviewer' }),
      )
      const summaries = await repo.summarizeByExecution(ws, e1)
      expect(summaries.map((s) => s.agentKind).sort()).toEqual(['coder', 'reviewer'])
    })

    it("records a subscription harness's per-call telemetry through the observability sink", async () => {
      // The proxy-bypassing path: Claude Code / Codex report per-call metrics off their CLI
      // stream, which the executor feeds through the SAME LlmObservabilityService the proxy
      // uses. This asserts that path lands correctly on each runtime's real store (bodies,
      // vendor, zero timing, and the delta chain), not just the raw repo round-trip above.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      let n = 0
      const record = makeHarnessCallRecorder(
        new LlmObservabilityService({
          llmCallMetricRepository: repo,
          idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
          clock: { now: () => 1 },
        }),
      )
      const call = (overrides: Partial<HarnessCallMetric>): HarnessCallMetric => ({
        model: 'claude-opus-4-8',
        promptText: '[]',
        messageCount: 1,
        responseText: '',
        reasoningText: '',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        finishReason: 'end_turn',
        ...overrides,
      })
      await record({
        workspaceId: ws,
        executionId: e1,
        agentKind: 'coder',
        provider: 'claude',
        model: 'claude:claude-opus-4-8',
        calls: [
          call({
            promptText: '[{"role":"system","content":"s"},{"role":"user","content":"u"}]',
            messageCount: 2,
            responseText: 'hi',
            inputTokens: 120,
            cachedInputTokens: 20,
            outputTokens: 30,
          }),
          call({
            promptText:
              '[{"role":"system","content":"s"},{"role":"user","content":"u"},{"role":"assistant","content":"hi"}]',
            messageCount: 3,
            responseText: 'done',
            inputTokens: 200,
            outputTokens: 40,
          }),
        ],
      })

      const rows = await repo.listByExecution(ws, e1)
      expect(rows).toHaveLength(2)
      const byResp = Object.fromEntries(rows.map((c) => [c.responseText, c]))
      const first = byResp['hi']!
      expect(first.provider).toBe('claude')
      expect(first.model).toBe('claude-opus-4-8') // the call's own model wins
      expect(first.promptTokens).toBe(120)
      expect(first.cachedPromptTokens).toBe(20)
      expect(first.completionTokens).toBe(30)
      // The CLIs expose no per-HTTP timing, so the split is zero.
      expect(first.totalMs).toBe(0)
      expect(first.upstreamMs).toBe(0)
      // The second call chained onto the first as a prompt delta on the real store.
      expect(byResp['done']!.promptPrefixCount).toBe(2)
    })

    it('ignores a re-recorded call instead of duplicating or overwriting its row', async () => {
      // A harness call reaches the backend more than once BY DESIGN: live as the harness
      // drains it mid-run, again in the job's terminal list, and again on a durable-driver
      // replay. Each mints the same `<jobId>-hc-<seq>` id, so the store must ignore the
      // repeat. Two ways this goes wrong on a real store, neither visible to a unit test: a
      // plain INSERT throws (dropping every LATER call in the same batch), and an UPSERT
      // rewrites the row's prompt delta against a chain tip that has since moved on.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      let n = 0
      const record = makeHarnessCallRecorder(
        new LlmObservabilityService({
          llmCallMetricRepository: repo,
          idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
          clock: { now: () => 1 },
        }),
      )
      // Each call's prompt extends the previous one, so the delta chain has something to
      // compress and a rewritten row would show it. `seq` is the harness's job-scoped sequence:
      // it — NOT the position in the batch — is what makes the two channels agree on a row id.
      const call = (seq: number, responseText: string): HarnessCallMetric => ({
        model: 'claude-opus-4-8',
        promptText: JSON.stringify(
          Array.from({ length: seq + 1 }, () => ({ role: 'user', content: 'u' })),
        ),
        messageCount: seq + 1,
        responseText,
        reasoningText: '',
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        finishReason: 'end_turn',
        seq,
      })
      const base = {
        workspaceId: ws,
        executionId: e1,
        agentKind: 'coder',
        provider: 'claude',
        model: 'claude:claude-opus-4-8',
        jobId: `${ws}-job`,
      }
      // The live drain records calls 0 and 1 as they happen...
      await record({ ...base, calls: [call(0, 'first'), call(1, 'second')] })
      // ...then the terminal write re-offers them ALONGSIDE the ones that never streamed —
      // deliberately NOT in `seq` order, so a recorder that fell back to the batch index would
      // mint `-hc-0` for 'third' and see it swallowed as a duplicate of 'first'.
      await record({
        ...base,
        calls: [call(2, 'third'), call(0, 'first'), call(3, 'fourth'), call(1, 'second')],
      })

      const rows = await repo.listByExecution(ws, e1)
      // Four calls, four rows: the repeats were ignored AND the new ones still landed — a
      // throwing INSERT would have aborted the batch and lost 'third' and 'fourth'.
      expect(rows).toHaveLength(4)
      expect(rows.map((r) => r.responseText).sort()).toEqual(['first', 'fourth', 'second', 'third'])
      // First write wins: the chain each row was stored against is intact, not recomputed
      // against a later tip, and the newly-landed calls chained onto it in order.
      const byResponse = Object.fromEntries(rows.map((r) => [r.responseText, r]))
      expect(byResponse['first']!.promptPrefixCount).toBe(0)
      expect(byResponse['second']!.promptPrefixCount).toBe(1)
      expect(byResponse['third']!.promptPrefixCount).toBe(2)
      expect(byResponse['fourth']!.promptPrefixCount).toBe(3)
    })

    it('keeps a promptless subagent call out of the prompt-delta chain', async () => {
      // Subagent calls carry no re-sendable request transcript (empty prompt, messageCount 0),
      // and they interleave with the parent's in RECORD order now that telemetry streams live.
      // If one becomes the chain tip, the next parent call can't chain onto it and stores its
      // whole prompt — so a subagent-heavy run loses the compression this chain exists for. The
      // clock advances per call here, which is what makes the subagent row the newest.
      const repo = makeRepo()
      const { ws, e1 } = ids()
      let n = 0
      let t = 0
      const record = makeHarnessCallRecorder(
        new LlmObservabilityService({
          llmCallMetricRepository: repo,
          idGenerator: { next: (p) => `${ws}-${p}-${(n += 1)}` },
          clock: { now: () => (t += 1) },
        }),
      )
      const base = {
        workspaceId: ws,
        executionId: e1,
        agentKind: 'pr-reviewer',
        provider: 'claude',
        model: 'claude:claude-opus-4-8',
      }
      const tokens = { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 }
      const parent = (messageCount: number, responseText: string): HarnessCallMetric => ({
        model: 'claude-opus-4-8',
        promptText: JSON.stringify(
          Array.from({ length: messageCount }, () => ({ role: 'user', content: 'u' })),
        ),
        messageCount,
        responseText,
        reasoningText: '',
        ...tokens,
        finishReason: 'end_turn',
      })
      const subagent = (responseText: string): HarnessCallMetric => ({
        model: 'claude-opus-4-8',
        promptText: '',
        messageCount: 0,
        responseText,
        reasoningText: '',
        ...tokens,
        finishReason: 'end_turn',
      })

      await record({ ...base, calls: [parent(1, 'p1')] })
      await record({ ...base, calls: [subagent('s1')] })
      await record({ ...base, calls: [parent(2, 'p2')] })

      const rows = await repo.listByExecution(ws, e1)
      const byResponse = Object.fromEntries(rows.map((r) => [r.responseText, r]))
      // The subagent row lands, as its own chain-less entry.
      expect(byResponse['s1']!.promptPrefixCount).toBe(0)
      // The parent call after it still chained onto the previous PARENT call (prefix 1), rather
      // than falling back to storing its whole prompt (prefix 0) — so what it stores is the ONE
      // new message, and the chain it hangs off is the parent's.
      expect(byResponse['p2']!.promptPrefixCount).toBe(1)
      expect(JSON.parse(byResponse['p2']!.promptText)).toHaveLength(1)
    })

    it('prunes rows older than a cutoff', async () => {
      const repo = makeRepo()
      const { ws, e1 } = ids()
      // Far-apart timestamps so the cutoff is unambiguous. `deleteOlderThan` is a
      // global (table-wide) retention prune, so its count can include other cases'
      // rows in the shared DB — assert the scoped, deterministic outcome instead.
      await repo.record(
        metric({ id: `${ws}-old`, workspaceId: ws, executionId: e1, createdAt: 1_000 }),
      )
      await repo.record(
        metric({ id: `${ws}-new`, workspaceId: ws, executionId: e1, createdAt: 9_000_000 }),
      )
      const removed = await repo.deleteOlderThan(2_000)
      expect(removed).toBeGreaterThanOrEqual(1)
      expect((await repo.listByExecution(ws, e1)).map((c) => c.id)).toEqual([`${ws}-new`])
    })
  })
}
