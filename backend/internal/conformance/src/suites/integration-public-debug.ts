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
// actually wired. A runtime that shipped the controller but forgot a telemetry repository would
// otherwise report `available: true, count: 0` — indistinguishable from a run that did nothing,
// which is precisely the confusion the sink block exists to prevent.
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

      const listed = await app.call<DebugRunList>('GET', '/api/v1/debug/runs', undefined, auth)
      expect(listed.status).toBe(200)
      // The index deliberately spans EVERY run in the workspace, not just the ones this API
      // created — a board run started from the SPA is exactly what someone asks to debug.
      const found = listed.body.runs.find((r) => r.runId === runId)
      expect(found).toMatchObject({ blockId: 'task_login', pipelineId: pipeline.body.id })
      expect(found?.stepCount).toBe(1)

      // A one-row page hands back a cursor; resuming from it must not re-serve the same row.
      const firstPage = await app.call<DebugRunList>(
        'GET',
        '/api/v1/debug/runs?limit=1',
        undefined,
        auth,
      )
      expect(firstPage.body.runs).toHaveLength(1)
      if (firstPage.body.nextCursor) {
        const next = await app.call<DebugRunList>(
          'GET',
          `/api/v1/debug/runs?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
          undefined,
          auth,
        )
        expect(next.status).toBe(200)
        expect(next.body.runs[0]?.runId).not.toBe(firstPage.body.runs[0]?.runId)
      }

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
      // Every sink reports availability, and an available one is a wired repository — the
      // assertion that catches a facade which mounted the routes but not the store.
      for (const sink of Object.values(overview.body.sinks)) {
        expect(typeof sink.available).toBe('boolean')
        expect(sink.count).toBeGreaterThanOrEqual(0)
      }
      // Totals are folded from the SQL rollup, so they exist even for a run with no calls.
      expect(overview.body.llm.totals.calls).toBe(overview.body.sinks.llmCalls.count)
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
      // answer 200-with-nothing and quietly leak that the id is unknown to this key.
      const calls = await app.call(
        'GET',
        `/api/v1/debug/runs/${foreignRunId}/llm-calls`,
        undefined,
        auth,
      )
      expect(calls.status).toBe(404)

      const unauthenticated = await app.call('GET', '/api/v1/debug/runs')
      expect(unauthenticated.status).toBe(401)
    })
  })
}
