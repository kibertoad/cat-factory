import type {
  Logger,
  McpOAuthTokenSource,
  McpSecretRef,
  McpServerDefinition,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { NotFoundError, isValidMcpToolName, noopLogger, runBestEffort } from '@cat-factory/kernel'
import { isReservedPlatformEnvKey, reservedEnvKeyMessage } from '@cat-factory/contracts'
import type { ToolServerProbeResult } from '@cat-factory/contracts'
import { MCP_PROBE_TOOL_NAME_CAP } from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { mergeHeaders } from '../../agents/toolServers.js'
import { notProbeableReason, resolveDeclaredToolServers } from './declaredToolServers.js'
import { type McpProbeDeps, probeMcpHttpServer } from './mcpProbe.js'

// ---------------------------------------------------------------------------
// PROBE one declared tool server: resolve its credentials exactly as a dispatch would, speak MCP to
// it, and report a cause.
//
// The point of the whole thing is that until now the only way to learn whether a wired tool server
// answers was to start a run and read the agent's prompt. Boot validation rules on the DECLARATION
// and a dispatch reports what it DROPPED, but a server that survives both — servable harness,
// allowed transport, credential present — could still be a dead url, a rotated token or a typo'd
// tool name, and every one of those surfaced as an agent quietly working without a tool it was
// promised.
//
// Two properties make the answer worth having, and both are about resolving through the SAME chain
// the dispatch does:
//
//   - the credential is looked up per WORKSPACE, through the composed `ToolSecretResolver`, so the
//     verdict is about this board rather than about whoever set the deployment's variable;
//   - the RESERVED-key floor is applied before the resolver is asked, exactly as
//     `resolveToolServers` applies it, so a probe can never be the one path that resolves a platform
//     configuration variable and ships it to a third party.
// ---------------------------------------------------------------------------

export interface ProbeToolServerInput {
  agentKindRegistry: AgentKindRegistry
  workspaceId: string
  /** The server id, from the request path. */
  serverId: string
  /**
   * The facade's composed capability-credential chain — the SAME resolver the container executor
   * dispatches with. Absent ⇒ the facade wired none, so a server declaring a required credential is
   * reported as `credentials_missing` rather than probed blind, which is the disposition the dispatch
   * path already applies to the same state.
   */
  resolveToolSecrets?: ToolSecretResolver
  /**
   * The facade's OAuth token source — the SAME one a dispatch mints an `Authorization` header
   * with. Absent ⇒ the deployment has no grant store, and a server declaring OAuth is reported as
   * `oauth_not_connected` rather than probed unauthenticated, which would report a working server
   * as a 401 and send the operator to the wrong fix.
   */
  resolveToolServerOAuth?: McpOAuthTokenSource
  logger?: Logger
  /** Injected for tests; forwarded to the protocol client. */
  probe?: McpProbeDeps
}

/**
 * Probe one server. Never throws for a PROBE outcome — a failure is data, because the operator is
 * asking a diagnostic question and an exception answers it with nothing.
 *
 * It does throw for a REFUSAL: an id no kind declares and nothing registered is a 404, not a status.
 * A verdict would be a lie there ("unreachable" for a server that does not exist), and the SPA's
 * list came from the same registry, so a 404 means the deployment changed under the operator.
 */
export async function probeToolServer(input: ProbeToolServerInput): Promise<ToolServerProbeResult> {
  const definition = findDefinition(input)
  const serverId = definition.id
  const refused = notProbeableReason(definition)
  if (refused) return { serverId, status: 'not_probeable', notProbeableReason: refused }
  // `notProbeableReason` already settled that this is an `http` transport with a reachable url; the
  // narrowing is re-stated for the type system rather than re-decided.
  if (definition.transport.kind !== 'http') {
    return { serverId, status: 'not_probeable', notProbeableReason: 'stdio_transport' }
  }

  const credentials = await resolveCredentials(input, definition)
  if (!credentials.ok) return { serverId, ...credentials.failure }
  const granted = await resolveOAuthHeader(input, definition, definition.transport.url)
  if (!granted.ok) return { serverId, ...granted.failure }

  const outcome = await probeMcpHttpServer(
    {
      url: definition.transport.url,
      // The declaration's own headers and the RESOLVED CREDENTIAL stay apart, because the protocol
      // client treats them differently at a redirect: a hop off the declared origin is refused while
      // a credential is riding, and a non-secret `x-tenant` is no reason to refuse anything.
      headers: { ...definition.transport.headers },
      // The granted token joins the CREDENTIAL side, not the declaration's own headers: it is the
      // secret a cross-origin redirect must not carry, which is the whole reason the probe keeps
      // the two apart. Last, so it wins a header a static credential also names — the same
      // precedence the dispatch applies (through the same case-insensitive merge, so the probe
      // cannot report on a header pair the dispatch would collapse), and boot warns about it.
      credentialHeaders: mergeHeaders(credentials.headers, granted.headers),
    },
    input.probe,
  )
  if (outcome.status !== 'ok') {
    input.logger?.warn('tool server probe failed', {
      toolServerId: serverId,
      workspaceId: input.workspaceId,
      status: outcome.status,
      ...('httpStatus' in outcome ? { httpStatus: outcome.httpStatus } : {}),
      detail: outcome.error,
    })
    return { serverId, ...outcome }
  }
  return {
    serverId,
    status: 'ok',
    serverName: outcome.serverName,
    serverVersion: outcome.serverVersion,
    protocolVersion: outcome.protocolVersion,
    toolCount: outcome.tools.length,
    tools: outcome.tools.slice(0, MCP_PROBE_TOOL_NAME_CAP),
    toolsComplete: outcome.toolsComplete,
    ...checkAllowedTools(definition, outcome.tools, outcome.toolsComplete),
  }
}

/**
 * The definition behind an id, through the SAME resolution the list surface projects.
 *
 * Shared rather than looked up here, and that is the point: a registry entry and a kind's INLINE
 * declaration may carry one id, so a second lookup with its own precedence would probe an endpoint
 * the row an operator clicked does not describe — a verdict about a different url, credential and
 * tool list, labelled with the id they recognise. One resolution makes that unrepresentable.
 */
function findDefinition(input: ProbeToolServerInput): McpServerDefinition {
  const declared = resolveDeclaredToolServers(input.agentKindRegistry).get(input.serverId)
  if (!declared) throw new NotFoundError('Tool server', input.serverId)
  return declared.definition
}

/**
 * Reconcile the definition's `allowedTools` against what the server actually exposes.
 *
 * The FIRST place in the platform that can. Registration, dispatch and the job boundary all hold
 * each entry to a NAME pattern, and none of them can tell a well-formed name from a real one: a
 * typo'd `search_issue` narrows claude-code's allow-list to a pattern matching nothing while the
 * prompt keeps advertising the name.
 *
 * Two things it will not claim. A name the DISPATCH would drop anyway (one that fails
 * `isValidMcpToolName`) is left out of `declared`, so the surface describes the list a run would
 * really send rather than the raw declaration. And an INCOMPLETE tool list yields no `unmatched` at
 * all: absence from a prefix is not evidence of absence from the server, and reporting a working
 * tool as missing would send an operator to edit a correct declaration.
 */
function checkAllowedTools(
  definition: McpServerDefinition,
  tools: string[],
  toolsComplete: boolean,
): Pick<ToolServerProbeResult, 'allowedTools'> {
  const declared = (definition.allowedTools ?? []).filter((name) => isValidMcpToolName(name))
  if (!declared.length) return {}
  const exposed = new Set(tools)
  return {
    allowedTools: {
      declared,
      unmatched: toolsComplete ? declared.filter((name) => !exposed.has(name)) : [],
      checked: toolsComplete,
    },
  }
}

/** Either the granted-token headers (possibly none), or the verdict the probe must report. */
type OAuthResolution =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; failure: Pick<ToolServerProbeResult, 'status' | 'error'> }

/**
 * Mint the access token an OAuth-declaring server needs, as the header its declaration named.
 *
 * The two failure statuses are the probe's whole value here. `oauth_not_connected` says nobody has
 * granted this board access, which is a Connect button rather than anything about the endpoint;
 * `oauth_token_failed` says a grant IS on file and produced nothing, which is a revocation, an
 * expiry, or an authorization server having a bad day. Probing anyway and reporting the 401 would
 * collapse both into "your credential is wrong", the one diagnosis that is false in both cases.
 */
async function resolveOAuthHeader(
  input: ProbeToolServerInput,
  definition: McpServerDefinition,
  serverUrl: string,
): Promise<OAuthResolution> {
  const oauth = definition.oauth
  if (!oauth) return { ok: true, headers: {} }
  const source = input.resolveToolServerOAuth
  if (!source) {
    return {
      ok: false,
      failure: {
        status: 'oauth_not_connected',
        error:
          'This deployment has no encryption key, so it has nowhere to keep an OAuth grant and ' +
          'no run can authenticate against this server either.',
      },
    }
  }
  const result = await source.accessToken({
    workspaceId: input.workspaceId,
    serverId: definition.id,
    serverUrl,
    oauth,
  })
  if (result.status === 'ok') return { ok: true, headers: { [result.header]: result.value } }
  if (result.status === 'not_connected')
    return { ok: false, failure: { status: 'oauth_not_connected' } }
  input.logger?.warn('tool server probe could not obtain an oauth token', {
    toolServerId: definition.id,
    workspaceId: input.workspaceId,
    detail: result.error,
  })
  return { ok: false, failure: { status: 'oauth_token_failed', error: result.error } }
}

type CredentialResolution =
  | { ok: true; headers: Record<string, string> }
  | {
      ok: false
      failure: Pick<
        ToolServerProbeResult,
        'status' | 'unresolvedCredentials' | 'refusedCredentials'
      >
    }

/**
 * Resolve the declared credentials into request headers, or report why the probe cannot proceed.
 *
 * This mirrors `resolveToolServers`'s `resolveSecrets` deliberately, including the ORDER: reserved
 * keys are dropped BEFORE the resolver is asked, because the floor must hold whatever a facade
 * wired. It reports the offending KEY NAMES rather than a sentence, so the surface can point at the
 * row in the credential checklist that needs a value.
 *
 * An `http` server's credential goes to a HEADER. A declaration that named only `envName` has
 * nothing to send over HTTP, so it contributes no header — and it is not a probe failure, because
 * such a declaration would resolve to nothing on a dispatch too (boot validation warns about it).
 */
async function resolveCredentials(
  input: ProbeToolServerInput,
  definition: McpServerDefinition,
): Promise<CredentialResolution> {
  const declared = definition.secretKeys ?? []
  if (!declared.length) return { ok: true, headers: {} }

  const reserved = declared.filter((secret) => isReservedPlatformEnvKey(secret.key))
  const requiredReserved = reserved.filter((secret) => secret.required !== false)
  for (const secret of reserved) {
    input.logger?.warn('tool server declares a reserved credential key; refusing to resolve it', {
      toolServerId: definition.id,
      credentialKey: secret.key,
      detail: reservedEnvKeyMessage(secret.key),
    })
  }
  if (requiredReserved.length) {
    return {
      ok: false,
      failure: {
        status: 'credential_refused',
        refusedCredentials: requiredReserved.map((secret) => secret.key),
      },
    }
  }

  const keys = declared.filter((secret) => !reserved.includes(secret))
  const resolver = input.resolveToolSecrets
  const resolved =
    resolver && keys.length
      ? ((await runBestEffort(
          input.logger ?? noopLogger,
          'resolve tool-server credentials for a probe',
          () =>
            resolver.resolve({
              workspaceId: input.workspaceId,
              subject: { kind: 'tool-server', id: definition.id },
              keys,
            }),
          { toolServerId: definition.id },
        )) ?? {})
      : {}

  // `required` defaults to TRUE, so an unresolved one settles the probe here: sending the request
  // without it would answer 401 and report the credential as WRONG rather than as absent, which are
  // different fixes.
  const missing = keys.filter((secret) => secret.required !== false && !resolved[secret.key])
  if (missing.length) {
    return {
      ok: false,
      failure: {
        status: 'credentials_missing',
        unresolvedCredentials: missing.map((secret) => secret.key),
      },
    }
  }
  return { ok: true, headers: credentialHeaders(keys, resolved) }
}

/** Fold each resolved value into the header its declaration named, through its `{value}` template. */
function credentialHeaders(
  keys: McpSecretRef[],
  resolved: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const secret of keys) {
    const value = resolved[secret.key]
    if (!value || !secret.header) continue
    headers[secret.header] = secret.headerTemplate
      ? secret.headerTemplate.replaceAll('{value}', value)
      : value
  }
  return headers
}
