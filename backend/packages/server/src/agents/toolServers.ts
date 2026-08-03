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
import { mcpServerSupportsHarness, noopLogger, runBestEffort } from '@cat-factory/kernel'
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

  for (const definition of declared.servers) {
    const label = definition.label ?? definition.id
    if (!servableOnThisRun(input, definition)) {
      unavailableToolServers.push({ id: definition.id, label, reason: 'harness_unsupported' })
      continue
    }
    const secrets = await resolveSecrets(input, definition)
    if (!secrets) {
      unavailableToolServers.push({ id: definition.id, label, reason: 'missing_secret' })
      continue
    }
    toolServers.push({
      id: definition.id,
      label,
      ...(definition.guidance ? { guidance: definition.guidance } : {}),
      ...(definition.allowedTools?.length ? { tools: definition.allowedTools } : {}),
      transport: definition.transport.kind,
    })
    mcpServers.push(buildJobSpec(definition, secrets))
  }
  return { toolServers, unavailableToolServers, mcpServers }
}

/**
 * Whether this run can actually serve the definition: the harness must speak MCP (and be one the
 * definition allows), AND the run must have somewhere per-job to put the server config. An ambient
 * Codex run fails the second test — see {@link ResolveToolServersInput.ambientAuth}.
 */
function servableOnThisRun(
  input: ResolveToolServersInput,
  definition: McpServerDefinition,
): boolean {
  if (!mcpServerSupportsHarness(definition, input.harness)) return false
  return !(input.ambientAuth && input.harness === 'codex')
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

/**
 * Resolve a server's declared credentials. Returns `null` when a REQUIRED secret is missing —
 * the caller then drops the server, because handing an agent a tool whose first call will 401 is
 * worse than telling it the tool is absent. A server with no declared secrets resolves trivially
 * (an empty record) without consulting the resolver at all.
 */
async function resolveSecrets(
  input: ResolveToolServersInput,
  definition: McpServerDefinition,
): Promise<Record<string, string> | null> {
  const keys = definition.secretKeys ?? []
  if (!keys.length) return {}
  const resolver = input.resolveToolSecrets
  const resolved = resolver
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
    if (key.required !== false && !resolved[key.key]) return null
  }
  return resolved
}

/**
 * Build the job-body spec, folding each resolved secret into the channel its declaration named:
 * an environment variable for a stdio server's child process, or a request header for an HTTP
 * one. A secret whose value is absent (an OPTIONAL one that did not resolve) is simply omitted,
 * so the server still starts without it.
 */
function buildJobSpec(
  definition: McpServerDefinition,
  secrets: Record<string, string>,
): McpServerJobSpec {
  const allowed = definition.allowedTools?.length ? { allowedTools: definition.allowedTools } : {}
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

/** Secrets destined for the server process's environment (every key that named no header). */
function envSecrets(
  keys: McpSecretRef[] | undefined,
  resolved: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys ?? []) {
    const value = resolved[key.key]
    if (value && !key.header) out[key.key] = value
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
   * Restrict which environment keys a tool server may read. Omitted ⇒ any key resolves.
   *
   * TRUST BOUNDARY. A tool-server definition is composition-root data, and it names BOTH the
   * credential it wants and the endpoint it talks to — so a definition can pair any key this
   * resolver will hand out with a transport that ships it somewhere. On Node that grants nothing
   * new (code running in the process can already read `process.env` directly), but on the Worker
   * it is a real widening: `env` is not ambient there, and a registration that could previously
   * see only what it was passed can now ask for any binding by name.
   *
   * That is fine for a deployment whose agent packages are all its own. Set this when it is not —
   * an installed third-party agent package is exactly the case the option exists for.
   *
   * **A MOTHERSHIP-MODE node is the third case, and it breaks the "grants nothing new on Node"
   * reasoning above.** A generative integration's definition now reaches such a node over
   * `/internal/binary-generators`, so the key name is chosen by the MOTHERSHIP rather than by
   * code this process runs, and the value it names is read from a developer's own laptop
   * environment. That is not a new grant in the adversarial sense — a mothership already supplies
   * the pipelines, prompts and repo targets of every run the node executes, so it can reach that
   * environment through any agent it dispatches — but it does turn a mis-declared key into a
   * developer's own token silently riding a job body. A node that wants a mis-declaration to fail
   * loudly instead sets this.
   *
   * It gates EVERY subject this resolver serves, not only tool servers: a generative binary
   * integration's credential (`BinaryGeneratorRegistry`) is resolved through the same port and is
   * held to the same list. So a `MCP_…`-prefixed convention is no longer sufficient on its own —
   * an allow-list that names only MCP keys silently resolves nothing for a registered image or
   * music generator, and the failure surfaces as the agent reporting the integration unavailable
   * rather than as anything pointing back here. List a prefix per subject family (`MCP_…`,
   * `GEN_…`), or the exact keys the registrations declare.
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
