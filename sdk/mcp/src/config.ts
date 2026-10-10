import { CAT_FACTORY_TOOL_GROUPS, type CatFactoryTool } from './tools.generated.ts'

// What a deployment can decide about this facade, and how it is read off the environment.
//
// Everything here narrows the tool set; nothing here changes what a tool DOES. That split is what
// keeps the facade thin: the API's own scopes are the authority on what a key may do, and a
// filter that pretended otherwise would be a second, weaker access-control story sitting in front
// of the real one.
//
// This module imports no Node built-in, and `runtime-neutral.test.ts` pins that: everything the
// hosted endpoint (`http.ts`) reaches is bundled into a deployment's Worker, where `node:fs` does
// not resolve at BUILD time. Which is why reading the key file is a dependency the executable
// injects rather than an import here.

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
   * Expose only these tools, by name (`tasks_get`, `decisions_list`, …). Absent or empty ⇒ every
   * tool the other filters leave.
   *
   * Beside the group filter rather than instead of it: a group is the unit an operator thinks in
   * ("no debug tools here"), and a tool is the unit a REFUSAL needs ("everything but the one that
   * merges"). With only the coarse filter, withholding `notifications_act` cost the whole inbox.
   */
  tools?: readonly string[]
  /**
   * Withhold these tools by name, after every other filter.
   *
   * The deny half is the one that carries the weight: an allow-list has to be re-edited every time
   * `/api/v1` grows, and a forgotten edit silently withholds a new capability, where a deny-list
   * keeps admitting new tools and goes on refusing exactly what was named.
   */
  excludeTools?: readonly string[]
  /**
   * Expose only the tools that change nothing (the GETs). For an agent that should be able to
   * READ a deployment and never act on it.
   *
   * On the STDIO server this is a convenience, NOT a security boundary: the tools are gone from
   * this server, but the key still carries whatever scope it was minted with, and anything else
   * holding it can still write. Mint a `read`-scoped key for the boundary — which is what the
   * hosted endpoint does the other way round, deriving this FROM the key (see
   * {@link readOnlyReason}).
   */
  readOnly?: boolean
  /**
   * Why {@link readOnly} is set. Defaults to `configured`.
   *
   * Carried because the two causes need DIFFERENT fixes and a model told only "writes are hidden"
   * cannot tell them apart: `configured` is an operator's switch on this server (edit the host
   * config), `key-scope` is the key itself being `read`-scoped (mint a wider key). Stated in the
   * instructions, so a model asks the person who can act rather than reporting the platform as
   * unable to write.
   */
  readOnlyReason?: ReadOnlyReason
  /** Ceiling on one tool result, in characters. See `DEFAULT_MAX_RESULT_CHARS`. */
  maxResultChars?: number
  /** Per-request deadline in ms, passed to the SDK; `0` disables it. */
  timeoutMs?: number
  /** Retries for a retriable failure, passed to the SDK. Only idempotent requests are retried. */
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

/**
 * Why the write tools are withheld.
 *
 * - `configured` — an operator started this server read-only.
 * - `key-scope`  — the key presented to it is `read`-scoped, so a write tool could only 403.
 *
 * A closed vocabulary rather than a free-form note: the instructions switch on it exhaustively,
 * so a third cause fails to compile until it has been written down for a model to read.
 */
export type ReadOnlyReason = 'configured' | 'key-scope'

/** The environment variables `optionsFromEnv` reads. */
export const ENV_VARS = {
  baseUrl: 'CAT_FACTORY_BASE_URL',
  apiKey: 'CAT_FACTORY_API_KEY',
  apiKeyFile: 'CAT_FACTORY_API_KEY_FILE',
  groups: 'CAT_FACTORY_MCP_GROUPS',
  tools: 'CAT_FACTORY_MCP_TOOLS',
  excludeTools: 'CAT_FACTORY_MCP_EXCLUDE_TOOLS',
  readOnly: 'CAT_FACTORY_MCP_READ_ONLY',
  maxResultChars: 'CAT_FACTORY_MCP_MAX_RESULT_CHARS',
  timeoutMs: 'CAT_FACTORY_MCP_TIMEOUT_MS',
  maxRetries: 'CAT_FACTORY_MCP_MAX_RETRIES',
} as const

/**
 * How `optionsFromEnv` reaches the filesystem.
 *
 * REQUIRED rather than defaulted to `readFileSync`, so this module imports no Node built-in: the
 * same modules are bundled into a deployment's hosted endpoint (see `http.ts`), and on workerd
 * `node:fs` does not resolve at build time — a default here would be a Worker that fails to BUILD
 * for the sake of a code path it can never take. Reading a file is the executable's business; the
 * `cat-factory-mcp` binary passes `readFileSync` and a test passes its own reader.
 */
export interface EnvReadDeps {
  readSecretFile: (path: string) => string
}

/**
 * Read the options an MCP host can supply: environment variables, because that is what every host
 * config format (Claude Desktop, an IDE, a CI runner) can set on a stdio server it spawns.
 *
 * Missing credentials THROW here rather than at the first tool call. An MCP server that starts,
 * lists 36 tools and then fails every one of them is the worst of both worlds: the host reports it
 * as connected, and the model spends turns discovering that nothing works.
 */
export function optionsFromEnv(
  env: Record<string, string | undefined>,
  deps: EnvReadDeps,
): CatFactoryMcpOptions {
  const baseUrl = env[ENV_VARS.baseUrl]?.trim()
  if (!baseUrl) throw new Error(`${ENV_VARS.baseUrl} is required (the deployment's origin).`)
  const apiKey = readApiKey(env, deps)
  // Read each ceiling ONCE. Every one of these is optional and must stay ABSENT rather than
  // become `undefined`, because the server spreads them onto the SDK's own options and an
  // explicit `undefined` is not the same as not passing the field.
  const groups = list(env[ENV_VARS.groups])
  const tools = list(env[ENV_VARS.tools])
  const excludeTools = list(env[ENV_VARS.excludeTools])
  const maxResultChars = numeric(env[ENV_VARS.maxResultChars], ENV_VARS.maxResultChars)
  const timeoutMs = numeric(env[ENV_VARS.timeoutMs], ENV_VARS.timeoutMs)
  const maxRetries = numeric(env[ENV_VARS.maxRetries], ENV_VARS.maxRetries)
  return {
    baseUrl,
    apiKey,
    ...(groups ? { groups } : {}),
    ...(tools ? { tools } : {}),
    ...(excludeTools ? { excludeTools } : {}),
    ...(isTruthy(env[ENV_VARS.readOnly]) ? { readOnly: true } : {}),
    ...(maxResultChars !== undefined ? { maxResultChars } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxRetries !== undefined ? { maxRetries } : {}),
  }
}

/**
 * The API key, from the variable or from the FILE the variable names.
 *
 * The file exists because a stdio server's environment is a host's config file: on every host that
 * matters that means a long-lived credential sitting in plaintext in a user's home directory, read
 * by every process that can read the file and copied into every backup and every screen share of
 * that config. A path is not a secret, so pointing at one keeps the key in a file the operator can
 * lock down (`chmod 600`, a mounted secret, a secrets-manager sidecar's drop) and out of the config
 * that gets shared.
 *
 * Declaring BOTH is refused rather than resolved by precedence. Two live sources for one credential
 * means a rotation can land on the one that is not being read, and the deployment goes on working
 * with the old key until it is revoked, which is exactly the moment nobody is looking.
 */
function readApiKey(env: Record<string, string | undefined>, deps: EnvReadDeps): string {
  const inline = env[ENV_VARS.apiKey]?.trim()
  const path = env[ENV_VARS.apiKeyFile]?.trim()
  if (inline && path) {
    throw new Error(
      `${ENV_VARS.apiKey} and ${ENV_VARS.apiKeyFile} are both set. Pick one: two sources for one ` +
        'credential means a rotation can land on the half nobody reads.',
    )
  }
  if (inline) return inline
  if (!path) {
    throw new Error(
      `${ENV_VARS.apiKey} is required (a public-API key), or ${ENV_VARS.apiKeyFile} naming a file ` +
        'that holds one.',
    )
  }
  let contents: string
  try {
    contents = deps.readSecretFile(path)
  } catch (error) {
    // The PATH is named and the cause is passed through; the contents never are, on any branch of
    // this function, because this message goes to a host's log.
    throw new Error(
      `${ENV_VARS.apiKeyFile} points at ${path}, which could not be read: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const key = contents.trim()
  if (!key) throw new Error(`${ENV_VARS.apiKeyFile} points at ${path}, which is empty.`)
  return key
}

function isTruthy(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true'
}

/** A comma-separated list, or undefined when the variable is unset or lists nothing. */
function list(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return entries && entries.length > 0 ? entries : undefined
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
 * What a server exposes, and what it withheld.
 *
 * The withheld halves are carried rather than discarded because the server states them in its
 * instructions: a model that can see `tasks_*` but not `debug_*` should be told the debug tools
 * were switched off HERE, or it will report the deployment as not supporting them. That is why
 * this is ONE value rather than a tool list plus a second look at the options. The instructions
 * are written from what the selection actually did, so a filter cannot be applied and left
 * unmentioned.
 */
export interface ToolSelection {
  exposed: CatFactoryTool[]
  /** Groups the operator switched off. Empty when no group filter was applied. */
  filteredGroups: string[]
  /** Why the write tools were withheld by `readOnly`, or null when they were not. */
  writeToolsHidden: ReadOnlyReason | null
  /** Tools the operator withheld BY NAME. Empty when no deny-list was applied. */
  deniedTools: string[]
  /** Whether an allow-list narrowed the server to an explicitly chosen set of tools. */
  toolsAllowListed: boolean
}

/** The tools a set of options exposes, and what was filtered out. */
export function selectTools(
  tools: readonly CatFactoryTool[],
  options: CatFactoryMcpOptions,
): ToolSelection {
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
  // Both name filters are checked against the WHOLE table rather than against what the group and
  // read-only filters have already left, so a name is judged on whether it exists at all. Checking
  // against the survivors would turn a redundant deny (a tool in a group that is off anyway) into a
  // startup failure, and redundancy in a safety list is not a mistake worth refusing to boot over.
  const allowed = namedTools(tools, options.tools, ENV_VARS.tools)
  const denied = namedTools(tools, options.excludeTools, ENV_VARS.excludeTools)
  const exposed = tools.filter(
    (tool) =>
      (!requested || requested.has(tool.group)) &&
      (!options.readOnly || tool.readOnly) &&
      (!allowed || allowed.has(tool.name)) &&
      !denied?.has(tool.name),
  )
  // Filters that combine to expose NOTHING are refused for the same reason an unknown group name
  // is: the host reports the server as connected either way, and a model with no tools looks
  // exactly like a model that has decided not to use any.
  if (exposed.length === 0) {
    throw new Error(
      'The configured filters expose no tools at all: ' +
        `groups=${options.groups?.join(',') ?? '(all)'}, readOnly=${options.readOnly === true}, ` +
        `tools=${options.tools?.join(',') ?? '(all)'}, ` +
        `excludeTools=${options.excludeTools?.join(',') ?? '(none)'}.`,
    )
  }
  const filteredGroups = [...known].filter((group) => requested !== null && !requested.has(group))
  return {
    exposed,
    filteredGroups,
    writeToolsHidden: options.readOnly === true ? (options.readOnlyReason ?? 'configured') : null,
    deniedTools: denied ? [...denied].sort() : [],
    toolsAllowListed: allowed !== null,
  }
}

/**
 * A validated set of tool names, or null when the filter is unset.
 *
 * An unknown name throws, naming the variable that carried it. A deny-list is the one filter whose
 * typo is silently DANGEROUS: `notifications_action` withholds nothing, and the tool the operator
 * meant to keep away from a model goes on being served.
 */
function namedTools(
  tools: readonly CatFactoryTool[],
  names: readonly string[] | undefined,
  variable: string,
): Set<string> | null {
  if (!names?.length) return null
  const known = new Set(tools.map((tool) => tool.name))
  const unknown = names.filter((name) => !known.has(name))
  if (unknown.length > 0) {
    throw new Error(
      `${variable} names tool(s) this server does not have: ${unknown.join(', ')}. ` +
        `A tool is named <group>_<method>; the known ones are: ${[...known].sort().join(', ')}.`,
    )
  }
  return new Set(names)
}
