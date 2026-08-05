import type { ExecutionInstance, Pipeline } from '@cat-factory/kernel'
import type { DebugRunList, DebugRunOverview } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// Cross-runtime conformance for the PUBLIC remote-debugging surface (`/api/v1/debug/*`).
//
// The repository-level parity of the four bounded reads is pinned by the per-store suites
// (`llm-metrics-suite`, `agent-context-suite`, `agent-search-queries-suite`,
// `provisioning-log-suite`), which drive the real SQL on both runtimes. What belongs HERE is the
// half those cannot see: that each facade MOUNTS the surface, resolves the run through its own
// execution store, and composes an overview whose per-sink availability reflects what that facade
// actually wired. Every conformance facade wires all four telemetry stores, so the overview test
// pins each sink to `available: true` — a facade that shipped the controller but forgot a
// repository reports `available: false` and fails there instead of shipping a surface that
// wrongly tells callers the deployment retains nothing.
//
// See backend/docs/debug-api.md.

/** Mint a public-API key of the given scope and return its bearer header. */
async function mintKey(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  workspaceId: string,
  scope: 'read' | 'write' | 'decide' | 'admin',
): Promise<Record<string, string>> {
  const created = await app.call<{ key: { id: string }; secret: string }>(
    'POST',
    `/workspaces/${workspaceId}/public-api-keys`,
    { label: `conformance-debug-${scope}`, scope },
  )
  expect(created.status).toBe(201)
  return { authorization: `Bearer ${created.body.secret}` }
}

/**
 * The tool-call sink's three routes: the public debug list's `?outcome=` narrowing, and the two
 * workspace-scoped reads the SPA panel makes.
 *
 * Lifted out of the detail-list test as one piece because it is one concern, and because that
 * test had grown past the statement budget — the ratchet's intended outcome, not a number to
 * raise.
 */
async function assertToolCallReads(
  app: Awaited<ReturnType<ConformanceHarness['makeApp']>>,
  opts: { wsId: string; runId: string; auth: Record<string, string> },
): Promise<void> {
  const { wsId, runId, auth } = opts
  // The outcome narrowing is ACCEPTED on both orders and REFUSED outside its picklist.
  //
  // Scoped deliberately: this run recorded no tool calls (the conformance agent is a fake
  // that makes none), so what a 200 here can prove is that each facade mounts the parameter,
  // not that a store honoured it. The two halves that matter live where rows exist —
  // `agent-tool-calls-suite` drives the real SQL on all three stores, and
  // `RunDebugService.listToolCalls`'s own test pins that the service forwards `outcome` INTO
  // the query rather than parsing it and dropping it, which is the failure that would answer
  // 200 with every row and read as a run whose every tool call failed.
  for (const url of [
    `/api/v1/debug/runs/${runId}/tool-calls?outcome=error&limit=5`,
    `/api/v1/debug/runs/${runId}/tool-calls?order=trajectory&outcome=error&limit=5`,
  ]) {
    const failing = await app.call<{ toolCalls: { ok: boolean }[] }>('GET', url, undefined, auth)
    expect(failing.status).toBe(200)
    expect(Array.isArray(failing.body.toolCalls)).toBe(true)
    // Vacuous on this run by construction, and kept because it is the assertion that stops
    // being vacuous the moment a facade's fake agent starts reporting spans.
    expect(failing.body.toolCalls.every((c) => c.ok === false)).toBe(true)
  }
  // Outside the picklist is a 400, not a silently unfiltered page: a caller that asked for
  // the failures and got every row back would read the run as all-failing.
  const badOutcome = await app.call(
    'GET',
    `/api/v1/debug/runs/${runId}/tool-calls?outcome=warning`,
    undefined,
    auth,
  )
  expect(badOutcome.status).toBe(400)

  // The SPA reads the SAME sink through its own workspace-scoped routes, and both hang off
  // `container.toolCallObservability` — a module the engine builds from the tool-call
  // repository. An unbuilt module does not error, it answers empty, which on this surface is
  // the "nothing failed in the container" claim the panel prints at the top of the page. So
  // the assertion that matters is that both routes EXIST and answer, on both facades.
  const panelRead = await app.call<{
    executionId: string
    toolCalls: unknown[]
    truncated: boolean
  }>('GET', `/workspaces/${wsId}/executions/${runId}/tool-calls`)
  expect(panelRead.status).toBe(200)
  expect(panelRead.body.executionId).toBe(runId)
  expect(Array.isArray(panelRead.body.toolCalls)).toBe(true)
  // A bound that is not being hit still has to SAY so: `truncated` absent from the payload
  // and `truncated: false` are the same value to a reader and opposite facts about the read.
  expect(panelRead.body.truncated).toBe(false)

  // The panel's headline read: exact run-level counts, never derived from the prefix above.
  const failureRead = await app.call<{
    executionId: string
    total: number
    failed: number
    failures: unknown[]
    failuresTruncated: boolean
  }>('GET', `/workspaces/${wsId}/executions/${runId}/tool-call-failures`)
  expect(failureRead.status).toBe(200)
  expect(failureRead.body.executionId).toBe(runId)
  // Counted in ONE aggregate pass, so `failed` above `total` is not a representable state on
  // any facade — the same invariant the debug overview's sink status is pinned to.
  expect(failureRead.body.failed).toBeLessThanOrEqual(failureRead.body.total)
  expect(failureRead.body.failures.length).toBeLessThanOrEqual(failureRead.body.failed)
  expect(failureRead.body.failuresTruncated).toBe(false)
}

export function definePublicDebugConformance(harness: ConformanceHarness): void {
  describe('public API — run debugging', () => {
    it("indexes the workspace's runs and pages them with an opaque cursor", async () => {
      const app = harness.makeApp()
      // Public-API keys are ACCOUNT-scoped, so the mint route refuses an account-less board.
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(started.status).toBe(201)
      const runId = started.body.id
      // A second run on a fresh task under a fresh frame (the other seeded tasks carry
      // dependencies or are done, so they refuse a start), so the one-row page below has a
      // real next page.
      const writeAuth = await mintKey(app, wsId, 'write')
      const frame = await app.call<{ id: string }>('POST', `/workspaces/${wsId}/blocks`, {
        type: 'service',
        position: { x: 500, y: 500 },
      })
      const task = await app.call<{ taskId: string }>(
        'POST',
        `/api/v1/services/${frame.body.id}/tasks`,
        { title: 'Debug paging task', description: 'second run' },
        writeAuth,
      )
      expect(task.status).toBe(201)
      const other = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/${task.body.taskId}/executions`,
        { pipelineId: pipeline.body.id },
      )
      expect(other.status).toBe(201)

      const listed = await app.call<DebugRunList>('GET', '/api/v1/debug/runs', undefined, auth)
      expect(listed.status).toBe(200)
      // The index deliberately spans EVERY run in the workspace, not just the ones this API
      // created — a board run started from the SPA is exactly what someone asks to debug.
      const found = listed.body.runs.find((r) => r.runId === runId)
      expect(found).toMatchObject({ blockId: 'task_login', pipelineId: pipeline.body.id })
      expect(found?.stepCount).toBe(1)

      // With two runs, a one-row page MUST hand back a cursor, and resuming from it must serve
      // the other run — never a repeat, never an empty tail while rows remain.
      const firstPage = await app.call<DebugRunList>(
        'GET',
        '/api/v1/debug/runs?limit=1',
        undefined,
        auth,
      )
      expect(firstPage.body.runs).toHaveLength(1)
      expect(firstPage.body.nextCursor).not.toBeNull()
      const next = await app.call<DebugRunList>(
        'GET',
        `/api/v1/debug/runs?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor!)}`,
        undefined,
        auth,
      )
      expect(next.status).toBe(200)
      expect(next.body.runs).toHaveLength(1)
      expect(next.body.runs[0]?.runId).not.toBe(firstPage.body.runs[0]?.runId)
      expect([firstPage.body.runs[0]?.runId, next.body.runs[0]?.runId].sort()).toEqual(
        [runId, other.body.id].sort(),
      )

      // The `status` and `since` narrowings are applied in SQL by `listRecent` — pin the wiring
      // from query param to predicate on each facade (the repo has no per-store suite).
      const failedOnly = await app.call<DebugRunList>(
        'GET',
        '/api/v1/debug/runs?status=failed',
        undefined,
        auth,
      )
      expect(failedOnly.body.runs).toHaveLength(0)
      const sinceFuture = await app.call<DebugRunList>(
        'GET',
        `/api/v1/debug/runs?since=${Date.now() + 3_600_000}`,
        undefined,
        auth,
      )
      expect(sinceFuture.body.runs).toHaveLength(0)
      const sinceEpoch = await app.call<DebugRunList>(
        'GET',
        '/api/v1/debug/runs?since=0',
        undefined,
        auth,
      )
      expect(sinceEpoch.body.runs.length).toBeGreaterThanOrEqual(2)

      // A corrupted cursor is a 400, never a silent re-serve of page one — for an autonomous
      // caller the latter is an infinite loop rather than a visible failure.
      const bad = await app.call('GET', '/api/v1/debug/runs?cursor=not-a-cursor', undefined, auth)
      expect(bad.status).toBe(400)
    })

    it('composes a run overview whose sink block reflects what THIS facade wired', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      const runId = started.body.id

      const overview = await app.call<DebugRunOverview>(
        'GET',
        `/api/v1/debug/runs/${runId}`,
        undefined,
        auth,
      )
      expect(overview.status).toBe(200)
      expect(overview.body.kind).toBe('cat-factory.run-debug-overview')
      expect(overview.body.run.runId).toBe(runId)
      expect(overview.body.steps.map((s) => s.agentKind)).toEqual(['coder'])
      // Every conformance facade wires all four telemetry repositories, so each sink MUST read
      // `available: true` here — this is the assertion that catches a facade which mounted the
      // routes but forgot a store (which would report `available: false` and pass a weaker
      // "is a boolean" check while contradicting what the facade actually retains).
      for (const sink of Object.values(overview.body.sinks)) {
        expect(sink.available).toBe(true)
        expect(sink.count).toBeGreaterThanOrEqual(0)
      }
      // Totals are folded from the SQL rollup, so they exist even for a run with no calls.
      expect(overview.body.llm.totals.calls).toBe(overview.body.sinks.llmCalls.count)
      // The tool-call sink carries the one number no LLM rollup can: how many of the run's tool
      // calls FAILED. It is counted in the same pass as the total, so it can never exceed it.
      expect(overview.body.sinks.toolCalls.failed).toBeLessThanOrEqual(
        overview.body.sinks.toolCalls.count,
      )
    })

    it('serves every per-run detail list for a real run, bounded and empty-safe', async () => {
      const app = harness.makeApp()
      const { workspace } = await app.createOrgWorkspace({ seed: true })
      const wsId = workspace.id
      const auth = await mintKey(app, wsId, 'read')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${wsId}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      const runId = started.body.id

      // A run whose sinks hold nothing must still answer 200 with an empty page: an endpoint that
      // errored on absent telemetry would make "nothing recorded" indistinguishable from a fault.
      for (const [path, key] of [
        ['llm-calls', 'calls'],
        ['agent-context', 'snapshots'],
        ['search-queries', 'queries'],
        ['tool-calls', 'toolCalls'],
        ['logs', 'entries'],
      ] as const) {
        const res = await app.call<Record<string, unknown[]>>(
          'GET',
          `/api/v1/debug/runs/${runId}/${path}?limit=5`,
          undefined,
          auth,
        )
        expect(res.status).toBe(200)
        expect(Array.isArray(res.body[key])).toBe(true)
      }

      // The query contract's ceiling is a real backstop, not a suggestion.
      const overLimit = await app.call(
        'GET',
        `/api/v1/debug/runs/${runId}/llm-calls?limit=5000`,
        undefined,
        auth,
      )
      expect(overLimit.status).toBe(400)

      // The trajectory ORDER is wired through the controller, and its one impossible combination
      // is refused rather than quietly served in the other order: `trajectory` returns a bounded
      // prefix and issues no cursor, so a caller supplying one is paging something that never
      // paginates — the same infinite loop a malformed cursor would cause.
      const trajectory = await app.call<{ toolCalls: unknown[]; nextCursor: string | null }>(
        'GET',
        `/api/v1/debug/runs/${runId}/tool-calls?order=trajectory&limit=5`,
        undefined,
        auth,
      )
      expect(trajectory.status).toBe(200)
      expect(trajectory.body.nextCursor).toBeNull()
      // A WELL-FORMED cursor (base64 of `1000|tc_1`), so this exercises the combination refusal
      // rather than the malformed-cursor 400 that guards the line above it.
      const resumedTrajectory = await app.call(
        'GET',
        `/api/v1/debug/runs/${runId}/tool-calls?order=trajectory&cursor=MTAwMHx0Y18x`,
        undefined,
        auth,
      )
      expect(resumedTrajectory.status).toBe(400)
      // The same cursor is FINE in the default order: what is refused is the pairing, not the
      // cursor, and an endpoint that rejected both would be unpageable.
      const resumedRecent = await app.call(
        'GET',
        `/api/v1/debug/runs/${runId}/tool-calls?cursor=MTAwMHx0Y18x`,
        undefined,
        auth,
      )
      expect(resumedRecent.status).toBe(200)

      await assertToolCallReads(app, { wsId, runId, auth })

      // The search and ordering narrowings ride the same route (their SQL semantics are pinned
      // by the per-store suite; what only this can see is that each facade wired the params).
      const searched = await app.call<{ calls: unknown[] }>(
        'GET',
        `/api/v1/debug/runs/${runId}/llm-calls?contains=${encodeURIComponent('Validation failed')}&order=oldest`,
        undefined,
        auth,
      )
      expect(searched.status).toBe(200)
      expect(searched.body.calls).toEqual([])
      // A search term over the contract's ceiling is refused like every other bound.
      const longTerm = await app.call(
        'GET',
        `/api/v1/debug/runs/${runId}/llm-calls?contains=${'x'.repeat(300)}`,
        undefined,
        auth,
      )
      expect(longTerm.status).toBe(400)

      // The phase narrowing is wired through the controller too, INCLUDING the empty value: `''`
      // selects the unattributed slice, so a facade (or a param reader) that treats it as absent
      // would answer this with the whole run rather than one slice of it.
      for (const phase of ['validation-repair', '']) {
        const byPhase = await app.call<{ calls: unknown[] }>(
          'GET',
          `/api/v1/debug/runs/${runId}/llm-calls?phase=${encodeURIComponent(phase)}`,
          undefined,
          auth,
        )
        expect(byPhase.status).toBe(200)
        expect(byPhase.body.calls).toEqual([])
      }

      // The two FLAT point reads (addressed by the row's own id, not nested under the run) are
      // mounted and workspace-scoped too: an unknown id is a 404 through the real controller +
      // service, never a 500 or an empty 200. Their body/slicing semantics are pinned by the
      // per-store suites; what only this can see is that each facade wired the route.
      const noCall = await app.call('GET', '/api/v1/debug/llm-calls/llm_nope', undefined, auth)
      expect(noCall.status).toBe(404)
      const noSnapshot = await app.call(
        'GET',
        '/api/v1/debug/agent-context/acs_nope',
        undefined,
        auth,
      )
      expect(noSnapshot.status).toBe(404)
      // The point-read body ceiling is enforced by the contract exactly like the list's limit.
      const overBudget = await app.call(
        'GET',
        '/api/v1/debug/llm-calls/llm_nope?bodyChars=999999999',
        undefined,
        auth,
      )
      expect(overBudget.status).toBe(400)
      // The window/view params are wired end to end: a valid ask still 404s on an unknown id
      // (never a 500 through the changed read path), an out-of-range offset is a 400.
      const windowed = await app.call(
        'GET',
        '/api/v1/debug/llm-calls/llm_nope?bodyChars=100&bodyOffset=500&view=messages',
        undefined,
        auth,
      )
      expect(windowed.status).toBe(404)
      const overOffset = await app.call(
        'GET',
        '/api/v1/debug/llm-calls/llm_nope?bodyOffset=999999999',
        undefined,
        auth,
      )
      expect(overOffset.status).toBe(400)
    })

    it('hides a run in another workspace, and refuses an unauthenticated call', async () => {
      const app = harness.makeApp()
      const { workspace: mine } = await app.createOrgWorkspace({ seed: true })
      const { workspace: theirs } = await app.createOrgWorkspace({ seed: true })
      const auth = await mintKey(app, mine.id, 'read')

      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${theirs.id}/pipelines`, {
        name: 'Coder only',
        agentKinds: ['coder'],
      })
      const started = await app.call<ExecutionInstance>(
        'POST',
        `/workspaces/${theirs.id}/blocks/task_login/executions`,
        { pipelineId: pipeline.body.id },
      )
      const foreignRunId = started.body.id

      // The key is workspace-scoped, so a foreign run is a 404 — indistinguishable from a run id
      // that never existed, which is what stops the surface confirming other tenants' ids.
      const overview = await app.call('GET', `/api/v1/debug/runs/${foreignRunId}`, undefined, auth)
      expect(overview.status).toBe(404)
      // The detail lists resolve the run first for exactly this reason: an unscoped list would
      // answer 200-with-nothing and quietly leak that the id is unknown to this key. All four
      // repeat the same guard, so all four are pinned.
      for (const path of ['llm-calls', 'agent-context', 'search-queries', 'logs']) {
        const res = await app.call(
          'GET',
          `/api/v1/debug/runs/${foreignRunId}/${path}`,
          undefined,
          auth,
        )
        expect(res.status).toBe(404)
      }

      const unauthenticated = await app.call('GET', '/api/v1/debug/runs')
      expect(unauthenticated.status).toBe(401)
    })
  })
}
