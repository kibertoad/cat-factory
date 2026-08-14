import type { AgentKind, AgentRunContext, Logger, UnavailableToolServer } from '@cat-factory/kernel'
import type { DispatchToolServers } from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { toolServersSection } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// The tool-server (MCP) CEILING of a consensus panel.
//
// A diverted step never reaches a container: its participants are plain inline model calls with no
// checkout, no shell and no agent CLI, so there is nothing for an MCP server to be wired INTO. That
// is a property of the panel, not of the kind: the default-eligible set is almost entirely
// container kinds (architect, analysis, the reviewers), which is exactly the set a deployment
// attaches a read-only research server to, and the SAME step with consensus off would have got it.
//
// Neither layer that normally reports a withheld tool server can see this one. Boot validation's
// `tool_servers_without_container` warning keys on the kind's declared surface, which is a
// container for every one of those kinds; and the container executor, which owns the whole
// unavailability vocabulary, is not on this path at all. So the panel reports it itself, in the two
// channels the container dispatch uses: the agent's own prompt, and the record the step carries.
// ---------------------------------------------------------------------------

/** What a diverted dispatch owes about the tool servers its kind declared. */
export interface PanelToolServerCeiling {
  /**
   * The prompt section stating what the panel cannot reach, ready to append to the participants'
   * system prompt. Empty when the kind declared no tool servers, so a panel on a kind with none
   * composes a byte-for-byte unchanged prompt.
   */
  section: string
  /**
   * The resolution to report back to the engine, which stamps the dispatched kind on it and
   * records it on the step. Absent when the kind declared no tool servers: an inline surface wires
   * nothing by construction, so an all-empty record from one would state that a resolution
   * happened where no wiring was ever possible, which is not what both-empty means on the
   * container path.
   */
  record?: DispatchToolServers
}

const NONE: PanelToolServerCeiling = { section: '' }

/**
 * Withhold every tool server the diverted kind declared, and say so.
 *
 * Every declared server is dropped under one reason, `consensus_panel`, because on this surface
 * there is only one: no transport, credential or harness test can change the answer, and running
 * them would resolve credentials for a dispatch that has nowhere to send them. That is also why
 * this reads the DECLARATIONS rather than calling the container executor's resolution.
 *
 * Ids a kind declared with no matching registration are skipped rather than listed: there is no
 * definition to name a label from, and boot validation already reported the typo as an error, so
 * inventing a chip for it would put a registry fault in front of the agent as a missing capability.
 * They are still LOGGED here, exactly as the container path re-reports them, because a
 * mothership-mode node boot-validates nothing it resolves: the definitions arrive per dispatch from
 * a process one build ahead of it, so the loud channel this relies on may never have fired for this
 * declaration. Skipped and unlogged, an unregistered id would leave no evidence anywhere.
 *
 * The prompt half goes through the SAME `toolServersSection` the container dispatch composes, so a
 * panel states a withheld server in the words a container run would, and inherits the drop list's
 * `maxStatedUnavailable` fold with it.
 */
export function panelToolServerCeiling(
  context: AgentRunContext,
  registry: AgentKindRegistry,
  logger?: Logger,
): PanelToolServerCeiling {
  const { servers: declared, unknown } = registry.toolServersFor(context.agentKind as AgentKind)
  for (const id of unknown) {
    logger?.warn('agent kind declares an unregistered tool server id; skipping it', {
      agentKind: context.agentKind,
      toolServerId: id,
    })
  }
  if (!declared.length) return NONE
  const unavailable: UnavailableToolServer[] = declared.map((definition) => ({
    id: definition.id,
    label: definition.label ?? definition.id,
    reason: 'consensus_panel',
  }))
  return {
    section: toolServersSection({
      ...context,
      toolServers: [],
      unavailableToolServers: unavailable,
    }),
    record: { wired: [], unavailable },
  }
}
