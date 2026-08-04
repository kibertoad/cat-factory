import { CAT_FACTORY_TOOL_GROUPS, type CatFactoryTool } from './tools.generated.ts'

// What a deployment can decide about this facade, and how it is read off the environment.
//
// Everything here narrows the tool set; nothing here changes what a tool DOES. That split is what
// keeps the facade thin: the API's own scopes are the authority on what a key may do, and a
// filter that pretended otherwise would be a second, weaker access-control story sitting in front
// of the real one.

/** How a `CatFactoryMcpServer` is configured. */
export interface CatFactoryMcpOptions {
  /** The deployment's origin, e.g. `https://cat-factory.example.com`. */
  baseUrl: string
  /** A public-API key: `cf_live_<keyId>.<secret>`. Its SCOPE decides what the tools may do. */
  apiKey: string
  /**
   * Expose only these resource groups (`jobs`, `tasks`, `debug`, …). Absent or empty ⇒ all of
   * them. An unknown group name is a startup ERROR rather than an empty selection: a typo that
   * silently exposed nothing would look exactly like a working server with a quiet model.
   */
  groups?: readonly string[]
  /**
   * Expose only the tools that change nothing (the GETs). For an agent that should be able to
   * READ a deployment and never act on it.
   *
   * This is a convenience, NOT a security boundary: the tools are gone from this server, but the
   * key still carries whatever scope it was minted with, and anything else holding it can still
   * write. Mint a `read`-scoped key for the boundary.
   */
  readOnly?: boolean
  /** Ceiling on one tool result, in characters. See `DEFAULT_MAX_RESULT_CHARS`. */
  maxResultChars?: number
  /** Per-request deadline in ms, passed to the SDK; `0` disables it. */
  timeoutMs?: number
  /** Retries for a retriable failure, passed to the SDK. */
  maxRetries?: number
  /**
   * Swap the HTTP implementation (a proxy agent, a test double), passed straight to the SDK.
   *
   * This is the ONLY injection point, deliberately: the facade always constructs its own client,
   * so a caller cannot hand it one pointed at a different deployment than these options describe,
   * or one that omits the `User-Agent` the deployment's audit trail identifies a model's calls by.
   */
  fetch?: typeof globalThis.fetch
}

/** The environment variables `optionsFromEnv` reads. */
export const ENV_VARS = {
  baseUrl: 'CAT_FACTORY_BASE_URL',
  apiKey: 'CAT_FACTORY_API_KEY',
  groups: 'CAT_FACTORY_MCP_GROUPS',
  readOnly: 'CAT_FACTORY_MCP_READ_ONLY',
  maxResultChars: 'CAT_FACTORY_MCP_MAX_RESULT_CHARS',
  timeoutMs: 'CAT_FACTORY_MCP_TIMEOUT_MS',
} as const

/**
 * Read the options an MCP host can supply: environment variables, because that is what every host
 * config format (Claude Desktop, an IDE, a CI runner) can set on a stdio server it spawns.
 *
 * Missing credentials THROW here rather than at the first tool call. An MCP server that starts,
 * lists 36 tools and then fails every one of them is the worst of both worlds: the host reports it
 * as connected, and the model spends turns discovering that nothing works.
 */
export function optionsFromEnv(env: Record<string, string | undefined>): CatFactoryMcpOptions {
  const baseUrl = env[ENV_VARS.baseUrl]?.trim()
  const apiKey = env[ENV_VARS.apiKey]?.trim()
  if (!baseUrl) throw new Error(`${ENV_VARS.baseUrl} is required (the deployment's origin).`)
  if (!apiKey) throw new Error(`${ENV_VARS.apiKey} is required (a public-API key).`)
  const groups = env[ENV_VARS.groups]
    ?.split(',')
    .map((group) => group.trim())
    .filter(Boolean)
  return {
    baseUrl,
    apiKey,
    ...(groups && groups.length > 0 ? { groups } : {}),
    ...(isTruthy(env[ENV_VARS.readOnly]) ? { readOnly: true } : {}),
    ...(numeric(env[ENV_VARS.maxResultChars], ENV_VARS.maxResultChars) !== undefined
      ? { maxResultChars: numeric(env[ENV_VARS.maxResultChars], ENV_VARS.maxResultChars) }
      : {}),
    ...(numeric(env[ENV_VARS.timeoutMs], ENV_VARS.timeoutMs) !== undefined
      ? { timeoutMs: numeric(env[ENV_VARS.timeoutMs], ENV_VARS.timeoutMs) }
      : {}),
  }
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

/**
 * A numeric env value, or undefined when unset.
 *
 * A NON-numeric value throws rather than falling back to the default. Everything this configures
 * is a ceiling, and a mistyped ceiling that silently reverts to the built-in one is a limit an
 * operator believes is in force and is not.
 */
function numeric(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number; got ${JSON.stringify(value)}.`)
  }
  return parsed
}

/**
 * The tools a set of options exposes, and what was filtered out.
 *
 * The filtered list is returned rather than discarded because the server states it in its
 * instructions: a model that can see `tasks_*` but not `debug_*` should be told that the debug
 * tools were switched off HERE, or it will report the deployment as not supporting them.
 */
export function selectTools(
  tools: readonly CatFactoryTool[],
  options: CatFactoryMcpOptions,
): { exposed: CatFactoryTool[]; filteredGroups: string[]; writeToolsHidden: boolean } {
  const known = new Set(Object.keys(CAT_FACTORY_TOOL_GROUPS))
  const requested = options.groups?.length ? new Set(options.groups) : null
  if (requested) {
    const unknown = [...requested].filter((group) => !known.has(group))
    if (unknown.length > 0) {
      throw new Error(
        `Unknown tool group(s): ${unknown.join(', ')}. Known groups: ${[...known].join(', ')}.`,
      )
    }
  }
  const exposed = tools.filter(
    (tool) => (!requested || requested.has(tool.group)) && (!options.readOnly || tool.readOnly),
  )
  const filteredGroups = [...known].filter((group) => requested !== null && !requested.has(group))
  return {
    exposed,
    filteredGroups,
    writeToolsHidden: options.readOnly === true,
  }
}
