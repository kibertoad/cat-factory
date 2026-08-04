import type { AgentKind, McpServerDefinition } from '@cat-factory/kernel'
import {
  isAllowedMcpHttpUrl,
  isLoopbackMcpHttpUrl,
  mcpServableHarnesses,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type { ToolServerNotProbeableReason, ToolServerView } from '@cat-factory/contracts'
import { stripUrlCredentials } from '../../agents/agentContextRecord.js'

// ---------------------------------------------------------------------------
// The DECLARATION half of the tool-server operability surface: every tool server this deployment
// registered, projected non-secretly, with the kinds that declare it and whether it can be probed
// from here at all.
//
// It lives in the server layer for the same reason `declaredCredentials.ts` does: it reads registry
// state, which only the composition root can supply. Pure otherwise, so the projection is testable
// with a bare registry and no container.
// ---------------------------------------------------------------------------

export interface CollectDeclaredToolServersInput {
  agentKindRegistry: AgentKindRegistry
}

/**
 * Every declared tool server, sorted by id.
 *
 * Two sources, unioned, because neither is complete on its own:
 *
 *   - walking `kindsWithCapabilities()` finds servers a kind actually gets, inline definitions
 *     included, and is the only way to learn WHICH kinds get them (`assignToolServers('coder', …)`
 *     is the recommended attachment path and no built-in is a registry entry, which is the hole
 *     `kindsWithCapabilities` exists to close);
 *   - `allToolServers()` finds registrations attached to NOTHING, which the walk structurally
 *     cannot see and which nothing else in the platform reports. Such a server never reaches a
 *     dispatch, so its credentials are keys an operator fills in for no run — reported here with an
 *     empty `declaredBy` rather than filtered out, because only the operator can tell a
 *     work-in-progress registration from a kind that lost its assignment in a refactor.
 */
export function collectDeclaredToolServers(
  input: CollectDeclaredToolServersInput,
): ToolServerView[] {
  const registry = input.agentKindRegistry
  const definitions = new Map<string, McpServerDefinition>()
  const kindsById = new Map<string, AgentKind[]>()

  for (const kind of registry.kindsWithCapabilities()) {
    for (const server of registry.toolServersFor(kind).servers) {
      // First definition wins, matching `normalizeToolRefs`: a kind may declare the same id inline
      // while another references the registration, and the dispatch resolves per kind. What this
      // surface can honestly show is one row per id, so it shows the first and names every kind.
      if (!definitions.has(server.id)) definitions.set(server.id, server)
      const kinds = kindsById.get(server.id)
      if (kinds) kinds.push(kind)
      else kindsById.set(server.id, [kind])
    }
  }
  for (const server of registry.allToolServers()) {
    if (!definitions.has(server.id)) definitions.set(server.id, server)
  }

  return [...definitions.values()]
    .map((definition) => toView(definition, kindsById.get(definition.id) ?? []))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Project one definition into its non-secret operator-facing view. */
function toView(definition: McpServerDefinition, declaredBy: AgentKind[]): ToolServerView {
  const notProbeable = notProbeableReason(definition)
  return {
    id: definition.id,
    label: definition.label ?? definition.id,
    transport: definition.transport.kind,
    target: describeTarget(definition),
    ...(definition.guidance ? { guidance: definition.guidance } : {}),
    declaredBy: [...declaredBy].sort(),
    servableHarnesses: mcpServableHarnesses(definition),
    ...(definition.allowedTools?.length ? { allowedTools: definition.allowedTools } : {}),
    credentials: (definition.secretKeys ?? []).map((secret) => ({
      key: secret.key,
      // `required` defaults to TRUE at the declaration site: a credential a server bothered to
      // declare is one it needs. Resolved here so no reader repeats the default.
      required: secret.required !== false,
      ...(secret.usage ? { usage: secret.usage } : {}),
    })),
    probeable: notProbeable === undefined,
    ...(notProbeable ? { notProbeableReason: notProbeable } : {}),
  }
}

/**
 * What the declaration points at, for recognition on the surface.
 *
 * A url is stripped of userinfo before it reaches a browser. That is not paranoia about a field an
 * operator authored: `https://user:token@mcp.example` is a legal declaration this platform accepts
 * (`isAllowedMcpHttpUrl` only rules on the scheme and host), so the url is a place a credential can
 * legitimately be, and rendering it verbatim would put that credential in a screenshot.
 */
function describeTarget(definition: McpServerDefinition): string {
  if (definition.transport.kind === 'http') return stripUrlCredentials(definition.transport.url)
  const args = definition.transport.args ?? []
  return [definition.transport.command, ...args].join(' ')
}

/**
 * Why this deployment cannot probe the definition, or undefined when it can.
 *
 * The order matters: the transport question comes first because a `stdio` server has no url to
 * judge at all, and answering `url_not_allowed` for one would name a fault it does not have.
 */
export function notProbeableReason(
  definition: McpServerDefinition,
): ToolServerNotProbeableReason | undefined {
  if (definition.transport.kind === 'stdio') return 'stdio_transport'
  const url = definition.transport.url
  if (!isAllowedMcpHttpUrl(url)) return 'url_not_allowed'
  // A loopback endpoint means "beside the agent, inside its own container". The backend's loopback
  // is a different machine, so probing it would answer about the wrong process whether it succeeded
  // or failed — and a success would be the more misleading of the two.
  if (isLoopbackMcpHttpUrl(url)) return 'container_local_url'
  return undefined
}
