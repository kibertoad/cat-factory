import type { AgentKind, McpServerDefinition } from '@cat-factory/kernel'
import {
  isAllowedMcpHttpUrl,
  isLoopbackMcpHttpUrl,
  mcpServableHarnesses,
  redactSecrets,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import type {
  ToolServerNotProbeableReason,
  ToolServerOAuthStatus,
  ToolServerView,
} from '@cat-factory/contracts'
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

/**
 * The non-secret half of a stored grant, as `McpOAuthService.listStatuses` returns it: everything
 * `ToolServerOAuthStatus` holds except the two fields the DECLARATION decides (`grant`) and this
 * projection derives (`connected`).
 */
export type StoredOAuthGrants = ReadonlyMap<
  string,
  Omit<ToolServerOAuthStatus, 'grant' | 'connected'>
>

export interface CollectDeclaredToolServersInput {
  agentKindRegistry: AgentKindRegistry
  /**
   * This workspace's grants, keyed by server id — read ONCE for the whole inventory rather than
   * per row, because the rows are the deployment's entire registry.
   *
   * Omitted ⇒ no grant store is wired, and every OAuth declaration renders as not connected, which
   * is the true state of a deployment that has nowhere to keep a grant.
   */
  oauthGrants?: StoredOAuthGrants
}

/** One declared server: the definition this surface answers for, and the kinds that reach it. */
export interface DeclaredToolServer {
  definition: McpServerDefinition
  declaredBy: AgentKind[]
}

/**
 * Every declared tool server by id — the ONE resolution both halves of this surface use.
 *
 * Shared rather than re-derived per caller, because the two halves disagreeing about which
 * definition an id names is invisible and mean: the row would describe one endpoint while the Test
 * button probed another, both labelled with the same id. So the LIST and the PROBE ask this.
 *
 * Two sources, unioned, because neither is complete on its own:
 *
 *   - walking `kindsWithCapabilities()` finds servers a kind actually gets, inline definitions
 *     included, and is the only way to learn WHICH kinds get them (`assignToolServers('coder', …)`
 *     is the recommended attachment path and no built-in is a registry entry, which is the hole
 *     `kindsWithCapabilities` exists to close);
 *   - `allToolServers()` finds registrations attached to NOTHING, which the walk structurally
 *     cannot see and which nothing else in the platform reports. Such a server never reaches a
 *     dispatch, so its credentials are keys an operator fills in for no run — reported with an
 *     empty `declaredBy` rather than filtered out, because only the operator can tell a
 *     work-in-progress registration from a kind that lost its assignment in a refactor.
 *
 * First definition wins, matching `normalizeToolRefs`: a kind may declare an id inline while another
 * references the registration, and the dispatch resolves per kind. What one surface can honestly
 * show is one row per id, so it shows the first and names every kind.
 */
export function resolveDeclaredToolServers(
  registry: AgentKindRegistry,
): Map<string, DeclaredToolServer> {
  const declared = new Map<string, DeclaredToolServer>()

  for (const kind of registry.kindsWithCapabilities()) {
    for (const server of registry.toolServersFor(kind).servers) {
      const existing = declared.get(server.id)
      if (existing) existing.declaredBy.push(kind)
      else declared.set(server.id, { definition: server, declaredBy: [kind] })
    }
  }
  for (const server of registry.allToolServers()) {
    if (!declared.has(server.id)) declared.set(server.id, { definition: server, declaredBy: [] })
  }

  return declared
}

/** Every declared tool server, projected non-secretly and sorted by id. */
export function collectDeclaredToolServers(
  input: CollectDeclaredToolServersInput,
): ToolServerView[] {
  return [...resolveDeclaredToolServers(input.agentKindRegistry).values()]
    .map((declared) =>
      toView(declared.definition, declared.declaredBy, input.oauthGrants ?? new Map()),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** Project one definition into its non-secret operator-facing view. */
function toView(
  definition: McpServerDefinition,
  declaredBy: AgentKind[],
  grants: StoredOAuthGrants,
): ToolServerView {
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
    ...oauthStatus(definition, grants),
    probeable: notProbeable === undefined,
    ...(notProbeable ? { notProbeableReason: notProbeable } : {}),
  }
}

/**
 * The OAuth half of a row: the declaration's grant type, joined to whether THIS workspace holds a
 * grant for it.
 *
 * Absent for a server that declares no OAuth, which is what keeps the Connect affordance off every
 * row it does not apply to. `connected` is derived from the presence of a stored grant rather than
 * stored as a flag, so a disconnect that removed the row cannot leave a row claiming otherwise.
 */
function oauthStatus(
  definition: McpServerDefinition,
  grants: StoredOAuthGrants,
): Pick<ToolServerView, 'oauth'> {
  const oauth = definition.oauth
  if (!oauth) return {}
  const stored = grants.get(definition.id)
  return { oauth: { grant: oauth.grant, connected: Boolean(stored), ...stored } }
}

/**
 * What the declaration points at, for recognition on the surface.
 *
 * BOTH shapes are scrubbed before they reach a browser, because both are places a credential can
 * legitimately sit. A url carries userinfo: `https://user:token@mcp.example` is a declaration this
 * platform accepts (`isAllowedMcpHttpUrl` only rules on the scheme and host), so it goes through
 * `stripUrlCredentials`. A `stdio` command line carries `--token=…` just as easily, and it is the
 * more tempting spot of the two for a deployment that has not found `secretKeys` yet — so the joined
 * argv goes through `redactSecrets`. Values in the credential store are write-only, which makes this
 * the one place on the surface where a pasted secret could otherwise be READ back.
 */
function describeTarget(definition: McpServerDefinition): string {
  if (definition.transport.kind === 'http') return stripUrlCredentials(definition.transport.url)
  const args = definition.transport.args ?? []
  return redactSecrets([definition.transport.command, ...args].join(' ')) ?? ''
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
