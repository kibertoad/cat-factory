import type { AgentKindRegistry } from '@cat-factory/agents'
import { runsInContainer } from '@cat-factory/agents'
import type { AgentKind, McpSecretRef, McpServerDefinition } from '@cat-factory/kernel'
import {
  MCP_OAUTH_DEFAULT_HEADER,
  MCP_SUPPORTED_HARNESSES,
  TOOL_SERVER_BUDGET,
  isAllowedMcpHttpUrl,
  isValidMcpServerId,
  isValidMcpToolName,
  mcpServableHarnesses,
  mcpTransportCarriesCredential,
  toolServerDeclaredBytes,
} from '@cat-factory/kernel'
import {
  isEnvVariableName,
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  reservedEnvKeyMessage,
  toolchainEnvNameMessage,
} from '@cat-factory/contracts'
import type { RegistrationProblem } from './validateRegistrations.js'

// ---------------------------------------------------------------------------
// Boot-time validation of one agent kind's declared TOOL SERVERS (MCP), the section of
// `collectRegistrationProblems` that grew its own gravity: the whole-list checks (unregistered
// ids, the per-dispatch budget, the container surface), each definition's own checks (id, url,
// transport, harness reachability, `allowedTools`), and the credential rules, which are the
// sharpest in the validator because a tool-server declaration names BOTH the key it wants and the
// endpoint that key is sent to.
//
// Split out of `validateRegistrations.ts` when it crossed the file-size budget, along the seam the
// checks already had: nothing here is called from anywhere but `checkKindToolServers`, which the
// capability walk calls once per kind.
// ---------------------------------------------------------------------------

/**
 * A kind's declared TOOL SERVERS: the whole-list checks (unregistered ids, the per-dispatch budget,
 * the container surface), with each definition's own checks in
 * {@link checkToolServerDefinition}. "Declared for" includes assigned servers, which is why the
 * capability walk in `validateRegistrations.ts` calls this per KIND rather than per registration.
 *
 * - an unregistered id is an ERROR, like an unregistered skill;
 * - past EITHER dimension of the per-dispatch budget is a WARNING, because the dispatch drops the
 *   excess under `over_budget` rather than failing: the run still works, with fewer tools than the
 *   deployment believes it wired, and boot is the only place the DECLARATIONS past the line can be
 *   named. A warning also keeps the accretion case honest, a kind going over budget through
 *   `assignToolServers` calls in several packages none of which is individually wrong. Both
 *   dimensions are checked because the dispatch enforces both, and a byte-driven drop is the one
 *   that surprises: a handful of servers with fat `env`/`args`/`headers` blocks is under the count
 *   and over the payload;
 * - tool servers on a NON-container kind is a WARNING: an inline LLM call has no CLI to wire them
 *   into, so they can never take effect. A warning rather than an error because a deployment may
 *   deliberately declare them ahead of moving the kind onto a container surface.
 */
export function checkKindToolServers(
  kind: AgentKind,
  registry: AgentKindRegistry,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const tools = registry.toolServersFor(kind)
  for (const id of tools.unknown) {
    problems.push({
      severity: 'error',
      code: 'unknown_tool_server',
      message:
        `Agent kind "${kind}" declares tool server "${id}", which is not registered. Call ` +
        `registry.registerToolServer({ id: '${id}', … }) before registering the kind, or ` +
        `declare the server inline.`,
    })
  }
  for (const server of tools.servers) problems.push(...checkToolServerDefinition(kind, server))
  problems.push(...checkToolServerBudget(kind, tools.servers))
  if (tools.servers.length && !runsInContainer(kind, registry)) {
    problems.push({
      severity: 'warn',
      code: 'tool_servers_without_container',
      message:
        `Agent kind "${kind}" declares tool servers but does not run in a container — an ` +
        `inline LLM step has no agent CLI to wire them into, so they will never be available. ` +
        `Give the kind a container surface (agent.surface: 'container-explore' / ` +
        `'container-coding') or drop the tool servers.`,
    })
  }
  return problems
}

/**
 * The per-dispatch budget, BOTH dimensions, as warnings: the dispatch drops the excess under
 * `over_budget` and the run works with fewer tools, so a registration fault belongs at boot rather
 * than in a refusal that takes the deployment down.
 *
 * The byte check measures {@link toolServerDeclaredBytes}, which is a FLOOR (a resolved credential
 * only adds to it), so a declaration already past the budget here is certainly past it at dispatch.
 * What boot deliberately does NOT claim is WHICH servers a run will lose: the dispatch keeps every
 * server that still fits, so once bytes are what bind the survivors are not a prefix of the
 * declaration. The count and the budget are what the author acts on, and the run itself names each
 * server it dropped.
 */
function checkToolServerBudget(
  kind: AgentKind,
  servers: readonly McpServerDefinition[],
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (servers.length > TOOL_SERVER_BUDGET.maxServers) {
    problems.push({
      severity: 'warn',
      code: 'too_many_tool_servers',
      message:
        `Agent kind "${kind}" has ${servers.length} tool servers declared for it, past the ` +
        `per-dispatch budget of ${TOOL_SERVER_BUDGET.maxServers}. A dispatch wires the first ` +
        `${TOOL_SERVER_BUDGET.maxServers} in declaration order and states the rest to the agent as ` +
        `unavailable (over_budget). Drop some, or split the work across kinds.`,
    })
  }
  const bytes = servers.reduce((total, server) => total + toolServerDeclaredBytes(server), 0)
  if (bytes > TOOL_SERVER_BUDGET.maxTotalBytes) {
    problems.push({
      severity: 'warn',
      code: 'tool_servers_over_byte_budget',
      message:
        `Agent kind "${kind}" declares tool servers whose transport config alone measures ${bytes} ` +
        `bytes, past the per-dispatch budget of ${TOOL_SERVER_BUDGET.maxTotalBytes}. A dispatch ` +
        `wires servers until that budget is spent and states the rest to the agent as unavailable ` +
        `(over_budget); resolved credentials only add to this figure, and which servers lose out ` +
        `depends on their sizes. Trim the env/args/headers blocks, or split the work across kinds.`,
    })
  }
  return problems
}

/**
 * ONE tool server definition:
 *
 * - a malformed MCP server id is an ERROR, because it becomes both a tool-name fragment and a
 *   Codex TOML table key, so the CLI fails on it far from the registration that caused it;
 * - an `allowedTools` entry that is not a valid tool NAME is an ERROR, the comma case above all:
 *   the harness joins the whole list into one `--allowedTools` argument with commas, so an entry
 *   carrying one splits into two patterns and the second matches nothing, while the prompt goes on
 *   advertising the name verbatim. That is the "told about a tool it cannot call" failure the
 *   unavailability vocabulary exists to prevent;
 * - a definition NO harness could ever serve is a WARNING, and it is the only check here a run
 *   structurally cannot report: an `http` server narrowed to `harnesses: ['codex']` (whose client
 *   is stdio-only), or anything narrowed to `['pi']` (which has no MCP client), is never dropped
 *   FOR A REASON on any run. It simply never applies, so no prompt and no log line ever mentions
 *   it. A warning rather than an error because the declaration is inert rather than dangerous;
 * - a cleartext `http://` endpoint off loopback is an ERROR: a resolved credential rides that
 *   request as a header, and the harness refuses the same URL at the job boundary — so allowing
 *   it here only moves the failure to a place with no registration to point at.
 */
function checkToolServerDefinition(
  kind: AgentKind,
  server: McpServerDefinition,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const on = `(on agent kind "${kind}")`
  if (!isValidMcpServerId(server.id)) {
    problems.push({
      severity: 'error',
      code: 'invalid_tool_server_id',
      message:
        `Tool server "${server.id}" ${on} has an invalid id. It becomes part of the tool names ` +
        `the CLI exposes (mcp__<id>__<tool>) and a Codex config key, so it must match ` +
        `[a-z0-9][a-z0-9_-]*.`,
    })
  }
  for (const tool of server.allowedTools ?? []) {
    if (isValidMcpToolName(tool)) continue
    problems.push({
      severity: 'error',
      code: 'invalid_tool_server_tool_name',
      message:
        `Tool server "${server.id}" ${on} restricts allowedTools to "${tool}", which is not a ` +
        `single tool name (letters, digits, "_", "." and "-"). The harness joins the list into ` +
        `one --allowedTools argument with commas, so an entry with a comma or whitespace becomes ` +
        `patterns that match nothing while the prompt still advertises the name. List each tool ` +
        `as its own entry.`,
    })
  }
  const servable = mcpServableHarnesses(server)
  if (servable.length === 0) {
    problems.push({
      severity: 'warn',
      code: 'tool_server_unservable',
      message:
        `Tool server "${server.id}" ${on} declares transport "${server.transport.kind}" for ` +
        `harnesses [${(server.harnesses ?? MCP_SUPPORTED_HARNESSES).join(', ')}], and no harness ` +
        `can serve that combination, so the server never applies to any run and no prompt or log ` +
        `line will say why. Codex's MCP client is stdio-only and Pi has none at all. Widen the ` +
        `harnesses, change the transport, or drop the declaration.`,
    })
  }
  if (server.transport.kind === 'http' && !isAllowedMcpHttpUrl(server.transport.url)) {
    problems.push({
      severity: 'error',
      code: 'insecure_tool_server_url',
      message:
        `Tool server "${server.id}" ${on} has url "${server.transport.url}". An HTTP tool server ` +
        `carries its resolved credential in a request header, so the url must be https (plain ` +
        `http is accepted only on loopback).`,
    })
  }
  for (const secret of server.secretKeys ?? []) {
    problems.push(...checkToolServerSecret(kind, server, secret))
  }
  problems.push(...checkToolServerOAuth(kind, server))
  return problems
}

/**
 * A tool server's OAUTH declaration, when it has one. Four rules, and each of them names a failure
 * that is otherwise invisible until a run or a button press:
 *
 * - `oauth` on a `stdio` server is an ERROR. A stdio server is a child process the CLI spawns;
 *   there is no request to authorise, so the declaration is inert and reads as configured. The
 *   dispatch drops the OAuth half silently for the mothership case, which is exactly why boot is
 *   where the fault has to be named.
 * - a declared endpoint that fails the URL floor is an ERROR, and this is the sharpest one here:
 *   an OAuth exchange carries the client secret and the tokens, so a cleartext endpoint puts both
 *   on the wire. A DISCOVERED endpoint is held to the same rule at the moment it is read.
 * - a reserved `clientSecretKey` is an ERROR for the reason every capability credential is: the
 *   declaration names both the key it wants and the token endpoint that key is posted to.
 * - a `secretKeys` entry naming the same header the access token rides is a WARNING. Both would
 *   land in one header map and the granted token wins, so the static credential silently does
 *   nothing — which reads, to whoever declared it, as the platform ignoring their credential.
 */
function checkToolServerOAuth(kind: AgentKind, server: McpServerDefinition): RegistrationProblem[] {
  const oauth = server.oauth
  if (!oauth) return []
  const problems: RegistrationProblem[] = []
  const on = `(on agent kind "${kind}")`
  if (server.transport.kind !== 'http') {
    problems.push({
      severity: 'error',
      code: 'oauth_requires_http_transport',
      message:
        `Tool server "${server.id}" ${on} declares OAuth on a "${server.transport.kind}" ` +
        `transport. OAuth authenticates a REQUEST, and a stdio server is a child process the ` +
        `agent CLI spawns with no request to authorise — pass its credential through secretKeys ` +
        `instead.`,
    })
  }
  for (const [field, url] of [
    ['authorizationUrl', oauth.authorizationUrl],
    ['tokenUrl', oauth.tokenUrl],
  ] as const) {
    if (url === undefined || isAllowedMcpHttpUrl(url)) continue
    problems.push({
      severity: 'error',
      code: 'insecure_oauth_endpoint',
      message:
        `Tool server "${server.id}" ${on} declares OAuth ${field} "${url}". The exchange carries ` +
        `the client secret and the access token, so the endpoint must be https (plain http is ` +
        `accepted only on loopback).`,
    })
  }
  if (oauth.clientSecretKey !== undefined && isReservedPlatformEnvKey(oauth.clientSecretKey)) {
    problems.push({
      severity: 'error',
      code: 'reserved_credential_key',
      message:
        `Tool server "${server.id}" ${on} declares OAuth client secret ` +
        reservedEnvKeyMessage(oauth.clientSecretKey),
    })
  }
  const tokenHeader = (oauth.header ?? MCP_OAUTH_DEFAULT_HEADER).toLowerCase()
  for (const secret of server.secretKeys ?? []) {
    if (secret.header?.toLowerCase() !== tokenHeader) continue
    problems.push({
      severity: 'warn',
      code: 'oauth_header_collision',
      message:
        `Tool server "${server.id}" ${on} declares credential "${secret.key}" on header ` +
        `"${secret.header}", which is also where its OAuth access token is sent. The granted ` +
        `token wins, so that credential reaches the server as nothing at all — send it under a ` +
        `different header, or drop it.`,
    })
  }
  return problems
}

/**
 * ONE credential a tool server declares. The reserved-key check is the sharpest rule in this file:
 * a definition names both the key it wants and the endpoint that key is sent to, so
 * `{ key: 'ENCRYPTION_KEY', header: 'Authorization' }` is a registration that boots clean and ships
 * the deployment's master sealing key to a third party. The generative-integration half of the same
 * rule is enforced by its credential SCHEMA (there is no schema here — a tool server is a TypeScript
 * registration), and dispatch refuses both again for the mothership case.
 */
/**
 * The credential's CHANNEL against the one its transport actually has
 * (`mcpTransportCarriesCredential`). Both mismatches are ERRORS, and they are the only rules here
 * that describe a declaration which does not work AT ALL: the value resolves, the projection that
 * builds the job body selects by channel and finds nothing to fold in, and the server is wired,
 * advertised in the prompt, and started unauthenticated. The `unused_credential_env_name` warning
 * below is deliberately not in this class, because there the value still arrives as the header and
 * only the redundant injection name is inert.
 *
 * Two codes rather than one, because the remedies are opposites and an operator reads the code:
 * a stdio declaration has a header to REMOVE, an http one has a header to ADD. Neither message
 * offers `envName` as the fix for a header on stdio, which was the first spelling of this rule and
 * was wrong twice over: the check keys on the header alone, so adding an `envName` beside it
 * re-fires the same error, and the env projection would go on skipping the key.
 */
function checkCredentialChannel(
  on: string,
  server: McpServerDefinition,
  secret: McpSecretRef,
): RegistrationProblem | undefined {
  if (mcpTransportCarriesCredential(server.transport.kind, secret)) return undefined
  const head = `Tool server "${server.id}" ${on} declares credential "${secret.key}"`
  switch (server.transport.kind) {
    case 'stdio':
      return {
        severity: 'error',
        code: 'unusable_credential_header',
        message:
          `${head} on header "${secret.header}", but a stdio server is a child process with no ` +
          `request to carry a header, so the value would reach nothing and the server would start ` +
          `without it. Remove the header: a stdio credential is injected into the server's own ` +
          `process, under envName when that process reads a different variable name.`,
      }
    case 'http':
      return {
        severity: 'error',
        code: 'missing_credential_header',
        message:
          `${head} with no header, but an http server is a remote URL with no process to inject a ` +
          `variable into, so the value would reach nothing and the server would be called ` +
          `unauthenticated. Declare the header it authenticates with, plus a headerTemplate when ` +
          `that header wants a scheme (e.g. "Bearer {value}").`,
      }
  }
}

function checkToolServerSecret(
  kind: AgentKind,
  server: McpServerDefinition,
  secret: McpSecretRef,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const on = `(on agent kind "${kind}")`
  if (isReservedPlatformEnvKey(secret.key)) {
    problems.push({
      severity: 'error',
      code: 'reserved_credential_key',
      message: `Tool server "${server.id}" ${on} declares credential ${reservedEnvKeyMessage(secret.key)}`,
    })
  }
  const channel = checkCredentialChannel(on, server, secret)
  if (channel) problems.push(channel)
  if (secret.envName === undefined) return problems
  // The injection name is NOT held to the reserved floor (it reads nothing), so it carries its own
  // rule: a value set as `PATH` or `npm_config_registry` reconfigures the server's process instead
  // of authenticating a call. Dispatch drops one too, for the mothership case.
  if (!isEnvVariableName(secret.envName)) {
    problems.push({
      severity: 'error',
      code: 'invalid_credential_env_name',
      message:
        `Tool server "${server.id}" ${on} declares credential envName "${secret.envName}", which ` +
        `is not a valid environment variable name. It becomes a variable of the server's process, ` +
        `and the harness drops anything else.`,
    })
  }
  if (isToolchainEnvName(secret.envName)) {
    problems.push({
      severity: 'error',
      code: 'toolchain_credential_env_name',
      message: `Tool server "${server.id}" ${on} declares credential ${toolchainEnvNameMessage(secret.envName)}`,
    })
  }
  // An `http` server sends its value as a HEADER, so an injection name would be read by nothing.
  // A warning rather than an error: the declaration still works, it just says something that cannot
  // take effect, and failing boot over it would be out of proportion.
  if (server.transport.kind === 'http' && secret.header) {
    problems.push({
      severity: 'warn',
      code: 'unused_credential_env_name',
      message:
        `Tool server "${server.id}" ${on} declares credential envName "${secret.envName}" on a ` +
        `key that names a header. An http server's value is sent as that header, so the injection ` +
        `name is never used.`,
    })
  }
  return problems
}
