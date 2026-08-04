import type {
  AgentKind,
  AgentRunContext,
  HarnessKind,
  Logger,
  McpSecretRef,
  McpServerDefinition,
  ResolvedToolServer,
  ToolSecretResolver,
  UnavailableToolServer,
} from '@cat-factory/kernel'
import {
  TOOL_SERVER_BUDGET,
  isValidMcpToolName,
  mcpHarnessServesTransport,
  mcpServerSupportsHarness,
  noopLogger,
  runBestEffort,
} from '@cat-factory/kernel'
import {
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  reservedEnvKeyMessage,
} from '@cat-factory/contracts'
import type { AgentKindRegistry } from '@cat-factory/agents'

// ---------------------------------------------------------------------------
// Tool servers (MCP) for one container dispatch: take the running agent kind's declared servers,
// drop the ones this run cannot serve, resolve each survivor's credentials, and split the result
// into the two channels a dispatch has.
//
//   - The PROMPT-FACING projection (`toolServers` / `unavailableToolServers` on the run context)
//     is non-secret, and IS captured in the agent-context telemetry snapshot.
//   - The job-body `mcpServers` field carries the transport plus its resolved credentials. It is
//     a dedicated TOP-LEVEL body field, which the snapshot's allow-list omits — the same channel
//     the tester's `testSecrets` uses, for the same reason.
//
// The filtering lives HERE, in the container executor's layer, rather than in the engine: whether
// a tool server can run at all depends on the resolved HARNESS (Pi has no MCP client) and on the
// facade-wired secret resolver, neither of which the runtime-neutral engine knows. A tool server
// is also inherently a CONTAINER capability, so there is nothing for an inline dispatch to do.
// ---------------------------------------------------------------------------

/** The per-server job-body spec the harness materialises for the agent CLI. */
export interface McpServerJobSpec {
  id: string
  transport: 'stdio' | 'http'
  /** stdio only. */
  command?: string
  args?: string[]
  /** stdio only: the server process's environment, INCLUDING any resolved secret values. */
  env?: Record<string, string>
  /** http only. */
  url?: string
  /** http only: request headers, INCLUDING any resolved credential header. */
  headers?: Record<string, string>
  /** Bare tool names the agent may call. Absent ⇒ every tool the server exposes. */
  allowedTools?: string[]
  /**
   * Which keys of `env` / `headers` above hold a RESOLVED CREDENTIAL rather than declared
   * configuration, so the harness can register exactly those values for redaction.
   *
   * The distinction has to travel: the two are merged into one map for the CLI's config, and a
   * harness that redacted the whole map would scrub ordinary config strings out of every log line
   * it ever writes (an `env` of `NODE_ENV: production` would turn every later "production" into
   * `***`). Names only — the values are already in the map beside them.
   */
  secretKeys?: string[]
}

export interface ResolveToolServersInput {
  context: AgentRunContext
  agentKindRegistry: AgentKindRegistry
  /** The harness this dispatch will run on — decides whether MCP is available at all. */
  harness: HarnessKind
  /**
   * Whether the run uses the developer's OWN CLI login (the local native transport) rather than a
   * leased credential. It matters here because an ambient Codex run has no per-run `CODEX_HOME` to
   * write servers into, and the harness will not write them into the developer's own `~/.codex`
   * (they would outlive the run and race a concurrent job) — so those servers are dropped HERE,
   * where the drop can be reported to the agent, rather than silently in the container.
   */
  ambientAuth?: boolean
  workspaceId: string
  blockId?: string
  /** Facade-wired; absent ⇒ a server declaring a required secret is dropped, never run blind. */
  resolveToolSecrets?: ToolSecretResolver
  logger?: Logger
}

export interface ResolvedToolServers {
  /** Prompt-facing, non-secret. Empty when the kind declared none (the built-in case). */
  toolServers: ResolvedToolServer[]
  /** Declared but not wired, with the reason. Empty when everything declared was wired. */
  unavailableToolServers: UnavailableToolServer[]
  /** The job-body field. Empty when nothing was wired. */
  mcpServers: McpServerJobSpec[]
}

const EMPTY: ResolvedToolServers = {
  toolServers: [],
  unavailableToolServers: [],
  mcpServers: [],
}

/**
 * Resolve the tool servers for one dispatch. Never throws: a server that cannot be wired is
 * reported as unavailable (which the prompt states) rather than failing the run — an agent told
 * a tool is missing does useful degraded work, while a run that refuses to start does none.
 */
export async function resolveToolServers(
  input: ResolveToolServersInput,
): Promise<ResolvedToolServers> {
  const declared = input.agentKindRegistry.toolServersFor(input.context.agentKind as AgentKind)
  if (!declared.servers.length) {
    reportUnknown(input, declared.unknown)
    return EMPTY
  }
  reportUnknown(input, declared.unknown)

  const toolServers: ResolvedToolServer[] = []
  const unavailableToolServers: UnavailableToolServer[] = []
  const mcpServers: McpServerJobSpec[] = []
  let bytes = 0

  for (const definition of declared.servers) {
    const label = definition.label ?? definition.id
    const unservable = servableOnThisRun(input, definition)
    if (unservable) {
      input.logger?.warn('tool server cannot be served on this run; stating it as unavailable', {
        agentKind: input.context.agentKind,
        toolServerId: definition.id,
        harness: input.harness,
        transport: definition.transport.kind,
        reason: unservable,
      })
      unavailableToolServers.push({ id: definition.id, label, reason: unservable })
      continue
    }
    // The COUNT half of the budget is settled BEFORE the credentials are resolved. The resolver is
    // a port a facade may back with a per-workspace store or a remote read, and a server past the
    // count can never be wired whatever it answers, so resolving it would spend a round trip (and
    // materialise a secret) for a server this dispatch has already lost. The BYTE half cannot move
    // up here: only the resolved spec has the size the job body actually carries.
    if (mcpServers.length >= TOOL_SERVER_BUDGET.maxServers) {
      logOverBudget(input, definition, { wired: mcpServers.length, bytes })
      unavailableToolServers.push({ id: definition.id, label, reason: 'over_budget' })
      continue
    }
    const secrets = await resolveSecrets(input, definition)
    if (!secrets.ok) {
      unavailableToolServers.push({ id: definition.id, label, reason: secrets.reason })
      continue
    }
    const allowedTools = sanitizeAllowedTools(input, definition)
    const spec = buildJobSpec(definition, secrets.values, allowedTools)
    // Measured on the RESOLVED spec, because that is the thing the job body carries: a
    // declaration's size says nothing about the env map its credentials fold into. Boot validation
    // measures the declaration alone (`toolServerDeclaredBytes`), which is a floor on this.
    const size = new TextEncoder().encode(JSON.stringify(spec)).length
    if (bytes + size > TOOL_SERVER_BUDGET.maxTotalBytes) {
      logOverBudget(input, definition, { wired: mcpServers.length, bytes, size })
      unavailableToolServers.push({ id: definition.id, label, reason: 'over_budget' })
      continue
    }
    bytes += size
    toolServers.push({
      id: definition.id,
      label,
      ...(definition.guidance ? { guidance: definition.guidance } : {}),
      ...(allowedTools?.length ? { tools: allowedTools } : {}),
      transport: definition.transport.kind,
    })
    mcpServers.push(spec)
  }
  return { toolServers, unavailableToolServers, mcpServers }
}

/** One report per server the budget cost this dispatch, naming which dimension bound. */
function logOverBudget(
  input: ResolveToolServersInput,
  definition: McpServerDefinition,
  spent: { wired: number; bytes: number; size?: number },
): void {
  input.logger?.warn('tool server dropped: the dispatch is over its tool-server budget', {
    agentKind: input.context.agentKind,
    toolServerId: definition.id,
    dimension: spent.size === undefined ? 'count' : 'bytes',
    wired: spent.wired,
    maxServers: TOOL_SERVER_BUDGET.maxServers,
    bytes: spent.bytes,
    ...(spent.size === undefined ? {} : { serverBytes: spent.size }),
    maxTotalBytes: TOOL_SERVER_BUDGET.maxTotalBytes,
  })
}

/**
 * The `allowedTools` list this dispatch may both STATE and send, holding each entry to
 * `isValidMcpToolName`.
 *
 * Registration refuses a bad entry, so this is the same belt-and-braces the reserved-key and
 * `envName` floors below get, and for the same reason: what the prompt advertises must be what the
 * CLI was actually given. The harness drops these entries at the job boundary, so an unfiltered
 * list here would leave the prompt naming a tool the allow-list never granted, which is the exact
 * failure the unavailability vocabulary exists to prevent.
 *
 * Nothing surviving is the same answer as an absent field (every tool the server exposes), matching
 * the harness: the alternative sends a list whose only entries are the CLI's own built-in tool
 * names, i.e. a run narrowed to no MCP tools at all.
 */
function sanitizeAllowedTools(
  input: ResolveToolServersInput,
  definition: McpServerDefinition,
): string[] | undefined {
  const declared = definition.allowedTools
  if (!declared?.length) return undefined
  const names = declared.filter((name) => isValidMcpToolName(name))
  if (names.length !== declared.length) {
    input.logger?.warn('tool server declares allowedTools entries that are not single tool names', {
      toolServerId: definition.id,
      dropped: declared.filter((name) => !isValidMcpToolName(name)),
      kept: names.length,
    })
  }
  return names.length ? names : undefined
}

/**
 * Why this run cannot serve the definition, or undefined when it can. Three tests, each with its
 * own reason because each names a different fix:
 *
 * 1. the harness must speak MCP and be one the definition allows (`harness_unsupported`);
 * 2. the harness's client must reach the definition's TRANSPORT (`transport_unsupported`). Codex is
 *    stdio-only, and this test is what stops an `http` server being advertised in the prompt
 *    ("prefer them over guessing") and then silently skipped by the harness's TOML writer;
 * 3. the run must have somewhere per-job to put the server config, which an ambient Codex run does
 *    not (see {@link ResolveToolServersInput.ambientAuth}). Reported as `harness_unsupported`
 *    because what is missing is the runtime's config home, not anything about the transport.
 */
function servableOnThisRun(
  input: ResolveToolServersInput,
  definition: McpServerDefinition,
): UnavailableToolServer['reason'] | undefined {
  if (!mcpServerSupportsHarness(definition, input.harness)) return 'harness_unsupported'
  if (!mcpHarnessServesTransport(input.harness, definition.transport.kind)) {
    return 'transport_unsupported'
  }
  if (input.ambientAuth && input.harness === 'codex') return 'harness_unsupported'
  return undefined
}

/**
 * An id a kind referenced with no matching registration. Boot validation already reported it as a
 * startup ERROR, so by the time a run reaches here the loud channel has fired; logging and moving
 * on is right, because failing the run cannot fix a registry typo.
 */
function reportUnknown(input: ResolveToolServersInput, unknown: readonly string[]): void {
  for (const id of unknown) {
    input.logger?.warn('agent kind declares an unregistered tool server id; skipping it', {
      agentKind: input.context.agentKind,
      toolServerId: id,
    })
  }
}

/** Either the resolved credential map, or the reason the server must be dropped. */
type SecretResolution =
  | { ok: true; values: Record<string, string> }
  | { ok: false; reason: 'missing_secret' | 'reserved_secret' }

/**
 * Resolve a server's declared credentials. Returns a REASON instead of a map when a REQUIRED
 * secret cannot be supplied — the caller then drops the server, because handing an agent a tool
 * whose first call will 401 is worse than telling it the tool is absent. A server with no
 * declared secrets resolves trivially (an empty record) without consulting the resolver at all.
 *
 * A key naming a platform configuration variable is dropped BEFORE the resolver is asked, and
 * that ordering is the point: the floor must hold whatever a facade wired, so it cannot live
 * inside the env-backed default. Boot validation already refused such a declaration, but a
 * mothership-mode node boot-validates nothing it resolves — the definitions arrive per dispatch
 * from a process one build ahead of it.
 */
async function resolveSecrets(
  input: ResolveToolServersInput,
  definition: McpServerDefinition,
): Promise<SecretResolution> {
  const declared = definition.secretKeys ?? []
  if (!declared.length) return { ok: true, values: {} }
  const reserved = declared.filter((key) => isReservedPlatformEnvKey(key.key))
  for (const key of reserved) {
    input.logger?.warn('tool server declares a reserved credential key; refusing to resolve it', {
      toolServerId: definition.id,
      credentialKey: key.key,
      detail: reservedEnvKeyMessage(key.key),
    })
    // A reserved REQUIRED key drops the server under its own reason. An optional one only costs
    // that key, exactly as an optional key that did not resolve does — the disposition follows
    // the DECLARATION, so this rule adds no second way for a server to disappear.
    if (key.required !== false) return { ok: false, reason: 'reserved_secret' }
  }
  const keys = reserved.length ? declared.filter((key) => !reserved.includes(key)) : declared
  const resolver = input.resolveToolSecrets
  const resolved =
    resolver && keys.length
      ? ((await runBestEffort(
          input.logger ?? noopLogger,
          'resolve tool-server credentials',
          () =>
            resolver.resolve({
              workspaceId: input.workspaceId,
              ...(input.blockId ? { blockId: input.blockId } : {}),
              subject: { kind: 'tool-server', id: definition.id },
              keys,
            }),
          { toolServerId: definition.id },
        )) ?? {})
      : {}
  for (const key of keys) {
    // `required` defaults to TRUE: a credential a server bothered to declare is one it needs.
    if (key.required !== false && !resolved[key.key]) return { ok: false, reason: 'missing_secret' }
  }
  return { ok: true, values: resolved }
}

/**
 * Build the job-body spec, folding each resolved secret into the channel its declaration named:
 * an environment variable for a stdio server's child process, or a request header for an HTTP
 * one. A secret whose value is absent (an OPTIONAL one that did not resolve) is simply omitted,
 * so the server still starts without it.
 *
 * `allowedTools` arrives already sanitised (see {@link sanitizeAllowedTools}) rather than being
 * read off the definition here, so the prompt projection and the body cannot disagree about which
 * tools the run was narrowed to.
 */
function buildJobSpec(
  definition: McpServerDefinition,
  secrets: Record<string, string>,
  allowedTools: string[] | undefined,
): McpServerJobSpec {
  const allowed = allowedTools?.length ? { allowedTools } : {}
  if (definition.transport.kind === 'stdio') {
    const credentials = envSecrets(definition.secretKeys, secrets)
    const env = { ...definition.transport.env, ...credentials }
    return {
      id: definition.id,
      transport: 'stdio',
      command: definition.transport.command,
      ...(definition.transport.args?.length ? { args: definition.transport.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
      ...allowed,
      ...secretKeyNames(credentials),
    }
  }
  const credentials = headerSecrets(definition.secretKeys, secrets)
  const headers = { ...definition.transport.headers, ...credentials }
  return {
    id: definition.id,
    transport: 'http',
    url: definition.transport.url,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...allowed,
    ...secretKeyNames(credentials),
  }
}

/**
 * Name the keys whose values came from the secret resolver, so the harness redacts those and only
 * those. Derived from the credentials actually folded in rather than from the DECLARATION: an
 * optional secret that did not resolve contributes no key, which keeps the list in step with what
 * the map really holds.
 */
function secretKeyNames(credentials: Record<string, string>): { secretKeys?: string[] } {
  const keys = Object.keys(credentials)
  return keys.length ? { secretKeys: keys } : {}
}

/**
 * Secrets destined for the server process's environment (every key that named no header).
 *
 * Keyed by the INJECTION name, which is `envName` when the declaration split it from the lookup
 * key. The resolver was asked for, and answered under, the lookup key; from here on only the
 * server process's own variable name matters. A declaration whose `envName` is a toolchain
 * variable is dropped rather than injected, because the value would reconfigure the process
 * instead of authenticating a call. Registration already refuses one, so this is the mothership
 * case: a definition authored elsewhere, boot-validated by nobody this process ran.
 */
function envSecrets(
  keys: McpSecretRef[] | undefined,
  resolved: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys ?? []) {
    const value = resolved[key.key]
    if (!value || key.header) continue
    const name = key.envName ?? key.key
    if (isToolchainEnvName(name)) continue
    out[name] = value
  }
  return out
}

/** Secrets destined for a request header, rendered through their `{value}` template. */
function headerSecrets(
  keys: McpSecretRef[] | undefined,
  resolved: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys ?? []) {
    const value = resolved[key.key]
    if (!value || !key.header) continue
    out[key.header] = key.headerTemplate ? key.headerTemplate.replaceAll('{value}', value) : value
  }
  return out
}

export interface EnvToolSecretResolverOptions {
  /**
   * Restrict which environment keys a capability credential may read. Omitted ⇒ any key that is
   * not RESERVED resolves (see below).
   *
   * TRUST BOUNDARY. A capability definition is composition-root data, and it names BOTH the
   * credential it wants and the endpoint it talks to — so a definition can pair any key this
   * resolver will hand out with a transport that ships it somewhere. On Node that grants nothing
   * new (code running in the process can already read `process.env` directly), but on the Worker
   * it is a real widening: `env` is not ambient there, and a registration that could previously
   * see only what it was passed can now ask for any binding by name.
   *
   * That is fine for a deployment whose agent packages are all its own. Set this when it is not —
   * an installed third-party agent package is exactly the case the option exists for, as is a
   * MOTHERSHIP-MODE node, whose generative-integration definitions arrive over
   * `/internal/binary-generators` and so name their keys from a process that is not this one,
   * against an environment that is a developer's own laptop.
   *
   * **This is the operator-stated bound, ON TOP of a platform-stated floor that needs no
   * configuration.** A key naming a variable the platform's own config owns
   * (`isReservedPlatformEnvKey`) is dropped by the dispatch call sites before this resolver is
   * ever asked, so `ENCRYPTION_KEY` and `HARNESS_SHARED_SECRET` are unreachable whether or not
   * this option is set — and setting it cannot widen that. What this adds is the narrower
   * boundary: everything OUTSIDE the platform's own configuration is a developer's own tooling
   * (`AWS_PROFILE`, a personal token), and only the operator knows which of those an integration
   * may see.
   *
   * It gates EVERY subject this resolver serves, not only tool servers: a generative binary
   * integration's credential (`BinaryGeneratorRegistry`) is resolved through the same port and is
   * held to the same list. So a `MCP_…`-prefixed convention is not sufficient on its own — an
   * allow-list that names only MCP keys silently resolves nothing for a registered image or music
   * generator, and the failure surfaces as the agent reporting the integration unavailable rather
   * than as anything pointing back here. List a prefix per subject family (`MCP_…`, `GEN_…`), or
   * the exact keys the registrations declare.
   *
   * Reachable from every facade: `startLocal` / `start` / `createWorker` take a
   * `createToolSecretResolver` factory, so wiring the narrower bound is
   * `createToolSecretResolver: (env) => createEnvToolSecretResolver(env, { allowKeys: [...] })`.
   */
  allowKeys?: Iterable<string>
}

/**
 * The deployment-environment tool-secret resolver both facades wire by default: each declared key
 * is read straight off the deployment's own configured environment (a Worker `env` binding, a Node
 * `process.env`).
 *
 * This is what makes a tool server usable with NO new storage, table or UI — the operator sets the
 * variable they already set for everything else. A deployment that needs PER-WORKSPACE credentials
 * implements the {@link ToolSecretResolver} port itself instead; nothing else in the dispatch path
 * changes, which is the whole reason the resolver is a port rather than an env read at the call site.
 *
 * See {@link EnvToolSecretResolverOptions.allowKeys} before deciding this default is right for a
 * deployment that installs agent packages it did not write.
 */
export function createEnvToolSecretResolver(
  env: Record<string, unknown> | undefined,
  options: EnvToolSecretResolverOptions = {},
): ToolSecretResolver {
  const allowed = options.allowKeys ? new Set(options.allowKeys) : undefined
  return {
    resolve: async ({ keys }) => {
      const out: Record<string, string> = {}
      for (const key of keys) {
        if (allowed && !allowed.has(key.key)) continue
        const value = env?.[key.key]
        if (typeof value === 'string' && value) out[key.key] = value
      }
      return out
    },
  }
}
