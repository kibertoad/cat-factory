import { defaultAgentKindRegistry } from '@cat-factory/agents'
import type { Pipeline } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { ConformanceHarness } from '../harness.js'

// ---------------------------------------------------------------------------
// Tool servers (MCP) at DISPATCH, and the capability credentials they resolve: the first
// cross-runtime assertions either subsystem has.
//
// Both shipped asserted on one runtime only, because the seam that decides them is the container
// executor's job body and the conformance suite runs a `FakeAgentExecutor` that composes none.
// What that hid is not hypothetical: whether a facade composes the per-workspace credential store
// IN FRONT of its environment resolver, and per KEY, is facade wiring, and a facade that got it
// wrong hands its agents a server authenticated as whoever set a deployment variable, or drops
// every credential a half-filled workspace has not typed yet. Neither failure is visible in a
// response body; both are visible here.
//
// The suite drives two seams for the two halves of one property:
//
//   - `toolServerDispatch()` observes the resolution itself, credentials included (the values are
//     write-only on every wire, so no HTTP route can show them);
//   - a driven RUN asserts the non-secret record survives the engine's fold and each runtime's
//     store, since a step is JSON in the run row on one facade and in another dialect's on the
//     other.
// ---------------------------------------------------------------------------

/** A `stdio` server whose credential the workspace stores, plus one whose credential nobody does. */
const STORED_KEY = 'CONFORMANCE_ISSUE_TOKEN'
const UNSTORED_KEY = 'CONFORMANCE_DOCS_TOKEN'

function registryWithToolServers() {
  const registry = defaultAgentKindRegistry()
  registry.register({
    kind: 'conformance-tooled-auditor',
    systemPrompt: 'You audit the service, using the tools you were given.',
    agent: { surface: 'container-explore' },
    toolServers: [
      {
        id: 'issues',
        label: 'Issue tracker',
        transport: { kind: 'stdio', command: 'npx', args: ['-y', 'issue-mcp'] },
        allowedTools: ['search_issues'],
        secretKeys: [{ key: STORED_KEY }],
      },
      {
        id: 'docs',
        label: 'Docs',
        transport: { kind: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] },
        secretKeys: [{ key: UNSTORED_KEY }],
      },
    ],
  })
  return registry
}

export function defineToolServerConformance(harness: ConformanceHarness): void {
  describe('tool servers (MCP) at dispatch', () => {
    it('resolves a stored credential into the job body and drops only the unstored server', async () => {
      const app = harness.makeApp({}, { agentKindRegistry: registryWithToolServers() })
      const probe = app.toolServerDispatch?.()
      if (!probe) return // A facade that exposes no container to observe; nothing to assert.
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id

      // One key of two, which is the whole point: composition is PER KEY, so a workspace that has
      // filled in half its checklist must keep the half it filled in. A "first resolver that
      // answers wins" chain passes every unit test and fails exactly here.
      const stored = await app.call(
        'PUT',
        `/workspaces/${wsId}/capability-credentials/${STORED_KEY}`,
        { value: 'stored-issue-token' },
      )
      expect(stored.status).toBe(200)

      const resolved = await probe.resolveForDispatch({
        workspaceId: wsId,
        agentKind: 'conformance-tooled-auditor',
        harness: 'claude-code',
      })

      // The credentialed server is wired, and the VALUE that reached the job body is this
      // workspace's, not a deployment-wide one, which is the single-tenant answer the store
      // exists to replace.
      expect(resolved.record.wired.map((s) => s.id)).toEqual(['issues'])
      const issues = resolved.mcpServers.find((s) => s.id === 'issues')
      expect(issues?.env?.[STORED_KEY]).toBe('stored-issue-token')
      // The harness redacts exactly the keys named here, so a credential missing from this list
      // is one that gets logged in the clear.
      expect(issues?.secretKeys).toEqual([STORED_KEY])

      // The other server is DROPPED with the reason, never dispatched blind, and never present in
      // the body under an empty value.
      expect(resolved.record.unavailable).toEqual([
        { id: 'docs', label: 'Docs', reason: 'missing_secret' },
      ])
      expect(resolved.mcpServers.map((s) => s.id)).toEqual(['issues'])

      // And the record the RUN would carry holds no credential value at all. It is persisted and
      // rendered in a browser, so this is a property of the projection, not of who reads it.
      expect(JSON.stringify(resolved.record)).not.toContain('stored-issue-token')
    })

    it('drops every server on a harness with no MCP client, stating the reason', async () => {
      // Pi has no MCP client, so a Pi run is the case where "declared" and "available" diverge for
      // a reason no credential can fix. It is asserted cross-runtime because the transport matrix
      // is what a facade's resolved harness feeds, and a facade that resolved the harness
      // differently would advertise tools its CLI cannot call.
      const app = harness.makeApp({}, { agentKindRegistry: registryWithToolServers() })
      const probe = app.toolServerDispatch?.()
      if (!probe) return
      const { workspace } = await app.createWorkspace()

      const resolved = await probe.resolveForDispatch({
        workspaceId: workspace.id,
        agentKind: 'conformance-tooled-auditor',
        harness: 'pi',
      })

      expect(resolved.record.wired).toEqual([])
      expect(resolved.mcpServers).toEqual([])
      expect(resolved.record.unavailable.map((s) => s.reason)).toEqual([
        'harness_unsupported',
        'harness_unsupported',
      ])
    })

    it('persists a dispatch’s tool-server record onto the run’s step', async () => {
      // The engine half: what the executor resolved has to survive `recordDispatchAttribution`,
      // the run's own JSON detail column and the read back out of it, on both stores. The fake
      // executor supplies the handle field a real `ContainerAgentExecutor` sets, so what is under
      // test here is the fold and the round trip, not the resolution (asserted above).
      const app = harness.makeApp(
        {
          // A real container dispatch is always async (`ContainerAgentExecutor.runsAsync` is
          // unconditionally true), and the fold happens at the DISPATCH site, so the kind has to
          // be driven through `startJob`/`pollJob` here or nothing produces a handle to fold.
          asyncKinds: ['conformance-tooled-auditor'],
          toolServers: {
            wired: [{ id: 'issues', label: 'Issue tracker', transport: 'stdio' }],
            unavailable: [{ id: 'docs', label: 'Docs', reason: 'missing_secret' }],
          },
        },
        { agentKindRegistry: registryWithToolServers() },
      )
      const { workspace } = await app.createWorkspace()
      const wsId = workspace.id
      const pipeline = await app.call<Pipeline>('POST', `/workspaces/${wsId}/pipelines`, {
        name: 'Tooled audit',
        agentKinds: ['conformance-tooled-auditor'],
      })
      const start = await app.call('POST', `/workspaces/${wsId}/blocks/task_login/executions`, {
        pipelineId: pipeline.body.id,
      })
      expect(start.status).toBe(201)

      const executions = await app.drive(wsId)
      const step = executions.find((e) => e.blockId === 'task_login')?.steps[0]
      expect(step?.toolServers?.wired.map((s) => s.id)).toEqual(['issues'])
      expect(step?.toolServers?.unavailable).toEqual([
        { id: 'docs', label: 'Docs', reason: 'missing_secret' },
      ])
    })
  })
}
