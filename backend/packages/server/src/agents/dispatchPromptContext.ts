import type { AgentRunContext } from '@cat-factory/kernel'
import type { DesignImageDelivery } from '@cat-factory/kernel'
import type { ResolvedToolServers } from './toolServers.js'
import type { ResolvedTestCredentials } from './testCredentials.js'

/**
 * The context the dispatch's PROMPTS are rendered from: the run context the engine built, plus
 * the facts only the dispatch knows.
 *
 * Its own function because the list keeps growing and each entry is there for the same reason: the
 * value depends on the RESOLVED harness, model or credential store, none of which the engine has
 * in hand when it builds the context. The prompt and the agent-context snapshot must both describe
 * the container that was actually started, so this is the one place a dispatch-level fact is
 * layered on, rather than each consumer re-deriving it and one of them forgetting.
 */
export function buildDispatchPromptContext(
  context: AgentRunContext,
  resolved: {
    /** What MCP the resolved harness could actually be given, and what could not be wired. */
    tools: ResolvedToolServers
    /** Whether the design pictures were attached, and the reason when they were not. */
    designImageDelivery?: DesignImageDelivery | undefined
    /**
     * The frame's test credentials as resolved HERE, from the read that produced the values this
     * job carries. It overrides the engine's own earlier read of the same store, and normally says
     * the same thing. When it does not, only this one describes the container the prompt is for,
     * and the divergence is the one that matters: a store that answered at admission and failed at
     * dispatch would otherwise advertise `$API_TOKEN` to an agent whose shell has no such
     * variable, which the agent reads as a service rejecting a credential it was given.
     */
    testCredentials?: ResolvedTestCredentials | undefined
  },
): AgentRunContext {
  const { tools, designImageDelivery, testCredentials } = resolved
  return {
    ...context,
    ...(tools.toolServers.length ? { toolServers: tools.toolServers } : {}),
    ...(tools.unavailableToolServers.length
      ? { unavailableToolServers: tools.unavailableToolServers }
      : {}),
    ...(designImageDelivery ? { designImageDelivery } : {}),
    ...(testCredentials ? { testSecrets: testCredentials.brief } : {}),
  }
}
