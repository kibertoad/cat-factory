import type { AgentKindRegistry } from '@cat-factory/agents'
import type { AgentRunContext, HarnessKind, ToolSecretResolver } from '@cat-factory/kernel'
import { resolveToolServers, stepToolServerRecord } from '@cat-factory/server'
import type { ToolServerDispatchProbe, ToolServerDispatchResult } from './harness.js'

// ---------------------------------------------------------------------------
// The DISPATCH-side observation seam for tool servers (MCP) and the capability credentials they
// resolve: the half of both subsystems no HTTP route exposes and no conformance assertion could
// reach before.
//
// The gap it closes: the conformance suite replaces `ContainerAgentExecutor` with
// `FakeAgentExecutor`, which composes no job body, so everything the container executor decides at
// dispatch (which servers this harness can serve, which credentials resolve for THIS workspace,
// what the run therefore records) was asserted on exactly one runtime, the one whose unit tests
// happened to cover it. A facade that wired its credential chain differently, or wired none, would
// pass every existing test and hand its agents an unauthenticated server.
//
// It is a thin binding rather than a re-implementation: it calls the SAME `resolveToolServers` the
// executor calls, with the facade's OWN composed chain off its container. That is what makes it an
// observation of the facade's wiring instead of a second wiring to keep in step: a probe that
// built its own resolver would answer identically on a facade that had none.
//
// The credentials DO reach this result (`mcpServers` carries the resolved values, exactly as the
// job body does), which is why the probe is a test-only seam over the container and never a route.
// ---------------------------------------------------------------------------

/** What the probe needs off a facade's built container: its registry and its composed chain. */
export interface ToolServerDispatchContainer {
  agentKindRegistry: AgentKindRegistry
  toolSecretResolver?: ToolSecretResolver | undefined
}

/**
 * Bind a facade's container into the dispatch probe.
 *
 * Deliberately NOT parameterised by an OAuth token source. A grant is per (workspace, server) state
 * a browser redirect creates, so a conformance run has none to observe, and injecting a fake one
 * would assert the fake rather than the facade. The OAuth path's own coverage is the probe
 * endpoint's verdicts and the executor's unit tests. What this seam is for is the two states every
 * deployment hits on every run: a credential the workspace stored, and one it did not.
 */
export function makeToolServerDispatchProbe(
  container: ToolServerDispatchContainer,
): ToolServerDispatchProbe {
  return {
    async resolveForDispatch(input): Promise<ToolServerDispatchResult> {
      const context = {
        agentKind: input.agentKind,
        pipelineName: 'conformance',
        stepIndex: 0,
        isFinalStep: true,
      } as unknown as AgentRunContext
      const resolved = await resolveToolServers({
        context,
        agentKindRegistry: container.agentKindRegistry,
        harness: input.harness as HarnessKind,
        workspaceId: input.workspaceId,
        ...(container.toolSecretResolver
          ? { resolveToolSecrets: container.toolSecretResolver }
          : {}),
      })
      return {
        record: stepToolServerRecord(resolved),
        mcpServers: resolved.mcpServers.map((server) => ({
          id: server.id,
          transport: server.transport,
          ...(server.env ? { env: server.env } : {}),
          ...(server.headers ? { headers: server.headers } : {}),
          ...(server.secretKeys ? { secretKeys: server.secretKeys } : {}),
        })),
      }
    },
  }
}
