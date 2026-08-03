import type { HarnessKind } from '../ports/model-provider.js'

// ---------------------------------------------------------------------------
// Agent CAPABILITIES — the skills an agent applies and the tool servers (MCP) it may call.
//
// Both are vocabulary an agent kind DECLARES and the engine resolves per dispatch, so this
// module holds the shapes that cross the layers: the agent-kind registry (`@cat-factory/agents`)
// declares them, the engine (`AgentContextBuilder`) resolves them onto `AgentRunContext`, the
// container executor renders them harness-aware into the job body, and the harness materialises
// them for the CLI it runs.
//
// The split that matters: a RESOLVED capability on `AgentRunContext` is PROMPT-FACING and
// therefore non-secret (the agent-context telemetry snapshot copies it verbatim). A tool
// server's credentials never appear here — they are resolved at dispatch straight into the
// job body's dedicated top-level field, exactly like the tester's `testSecrets`.
// ---------------------------------------------------------------------------

/** One resource file of a skill, fetched at the skill's pinned commit. */
export interface ResolvedSkillResource {
  /** Repo-relative path (used to reference an un-materialised resource in the prompt). */
  path: string
  /** Path within the skill directory (where it materialises, under the skill / `.cat-context/skill`). */
  relPath: string
  /** File body; absent when the resource was oversized / binary / unreadable at dispatch. */
  body?: string
}

/**
 * A skill resolved for one dispatch — the procedural instructions (a `SKILL.md` body) plus its
 * sibling resources. Two origins produce the identical shape, so nothing downstream branches on
 * where a skill came from:
 *
 * - **catalog** — a repo-sourced skill synced into the account's skill catalog (ADR 0024),
 *   picked per step (`stepOptions.skillId`) or declared by an agent kind.
 * - **bundled** — a skill shipped IN CODE by the deployment's agent package and registered on
 *   the `AgentKindRegistry`. It needs no repo, no sync and no GitHub connection, which is what
 *   makes a custom agent kind's own playbook installable on a deployment that has no skill
 *   library configured at all.
 */
export interface ResolvedSkill {
  /** The skill id — `src:<sourceId>:<dirName>` for a catalog skill, the registered id for a bundled one. */
  skillId: string
  /** Where the skill came from (a bundled skill is never version-pinned — its version is the deployment's). */
  origin: 'catalog' | 'bundled'
  /** Skill name (the native CLI skill directory name + the `SKILL.md` frontmatter `name`). */
  name: string
  /** One-line description (the `SKILL.md` frontmatter `description`; feeds the native manifest). */
  description: string
  /** The procedural instructions — the `SKILL.md` body. */
  instructions: string
  /** Sibling resource files (capped; oversized/binary/unreadable ones omit `body`). */
  resources: ResolvedSkillResource[]
}

/** The per-run version pin recorded on a step for a CATALOG skill (a bundled skill has none). */
export interface SkillVersionPin {
  skillId: string
  commit: string | null
  sha: string
}

// ---------------------------------------------------------------------------
// Tool servers (MCP)
// ---------------------------------------------------------------------------

/** A tool server the harness starts as a child process inside the run container. */
export interface McpStdioTransport {
  kind: 'stdio'
  command: string
  args?: string[]
  /** Non-secret environment for the server process. Secrets ride {@link McpServerDefinition.secretKeys}. */
  env?: Record<string, string>
}

/** A tool server the agent CLI reaches over HTTP (streamable HTTP / SSE endpoint). */
export interface McpHttpTransport {
  kind: 'http'
  url: string
  /** Non-secret headers. A credential header is produced from a resolved secret instead. */
  headers?: Record<string, string>
}

export type McpTransport = McpStdioTransport | McpHttpTransport

/**
 * A secret a tool server needs, declared by NAME only. The value is resolved at dispatch by the
 * facade-wired {@link import('../ports/agent-tools.js').ToolSecretResolver} and injected straight
 * into the job body — it never reaches `AgentRunContext`, a prompt, or the telemetry snapshot.
 */
export interface McpSecretRef {
  /**
   * The secret's key. For a `stdio` server it becomes an environment variable of the server
   * process; for an `http` server the resolved value is sent as the {@link McpSecretRef.header}
   * request header (shaped by {@link McpSecretRef.headerTemplate}).
   *
   * It may NOT name a variable the platform's own configuration owns (`isReservedPlatformEnvKey`
   * in `@cat-factory/contracts`) — the default resolver reads the key straight off the
   * deployment's environment, and a definition names both the key it wants AND the endpoint that
   * key is sent to. Boot validation refuses one, and dispatch refuses it again for the mothership
   * case, where the definition was authored by a process that is not this one.
   */
  key: string
  /**
   * `http` only: the request header the value is sent as (e.g. `Authorization`). The value is
   * substituted into {@link headerTemplate}. Omitted ⇒ the secret is passed as an env var, which
   * an `http` server has no use for, so declare one for an HTTP tool server.
   */
  header?: string
  /**
   * The header value template, with `{value}` standing in for the secret (e.g. `Bearer {value}`).
   * Omitted ⇒ the bare value. Only meaningful alongside {@link header}.
   */
  headerTemplate?: string
  /**
   * When true, the tool server is DROPPED (with a note in the prompt) if this secret does not
   * resolve. Defaults to true: a tool that will fail on its first call is worse than one the
   * agent was told it does not have. Set false for a genuinely optional credential.
   */
  required?: boolean
}

/**
 * A tool server (MCP) an agent kind can be given. Registered on the `AgentKindRegistry` by id and
 * referenced from any number of kinds, or declared inline on a single kind.
 *
 * Deployment-STATIC data (a composition-root registration), exactly like an agent kind itself —
 * the per-tenant half is the credential, which is resolved through the `ToolSecretResolver` port.
 */
export interface McpServerDefinition {
  /**
   * Stable id, used as the MCP server NAME the CLI exposes tools under (`mcp__<id>__<tool>`), so
   * it must be a safe identifier — see {@link isValidMcpServerId}.
   */
  id: string
  /** Human label for the prompt section + the run's diagnostics. Defaults to the id. */
  label?: string
  /**
   * One or two sentences telling the agent WHAT this server is for and when to reach for it,
   * folded into the prompt's tool-server section. Without it an agent tends to ignore a tool it
   * was handed, so this is the difference between a wired server and a used one.
   */
  guidance?: string
  transport: McpTransport
  /**
   * Restrict which of the server's tools the agent may call (bare tool names, e.g. `search_issues`).
   * Omitted ⇒ every tool the server exposes.
   *
   * This is SCOPING, not a security boundary. It is always stated in the prompt (every harness),
   * and additionally passed to the claude-code CLI's `--allowedTools` — but the run's permission
   * mode decides whether the CLI treats that list as a gate at all, and Codex's config cannot
   * express a per-tool restriction. A server whose other tools an agent kind must genuinely never
   * reach should not be wired for that kind at all, rather than wired and narrowed.
   */
  allowedTools?: string[]
  /**
   * Which harnesses can serve this server. Defaults to {@link MCP_SUPPORTED_HARNESSES} — the CLIs
   * that speak MCP. A run on a harness outside the list keeps working; the server is dropped and
   * the prompt says so, rather than the agent being told about a tool it cannot call.
   */
  harnesses?: HarnessKind[]
  /** Credentials the server needs, by name. Resolved at dispatch; never rendered into a prompt. */
  secretKeys?: McpSecretRef[]
}

/**
 * The prompt-facing projection of a tool server that was actually wired for this dispatch. Carried
 * on `AgentRunContext` (so it IS captured in the agent-context snapshot) and therefore free of
 * every credential.
 */
export interface ResolvedToolServer {
  id: string
  label: string
  guidance?: string
  /** The tools the agent may call, when the definition restricted them. Absent ⇒ all of them. */
  tools?: string[]
  /** Transport kind, so the prompt can say whether the tool is local to the container or remote. */
  transport: McpTransport['kind']
}

/**
 * A tool server that was declared but NOT wired for this dispatch, with the reason — surfaced in
 * the prompt so the agent plans around a missing tool instead of discovering it mid-run, and in
 * the run's context snapshot so an operator can see why.
 */
export interface UnavailableToolServer {
  id: string
  label: string
  /**
   * `reserved_secret` is kept apart from `missing_secret` because the two need OPPOSITE fixes and
   * a single value would send an operator to the wrong one: a missing secret is a variable to set,
   * while a reserved one is a DECLARATION to change — the server named a variable the platform's
   * own configuration owns, and setting it is exactly what must not help.
   */
  reason: 'harness_unsupported' | 'missing_secret' | 'reserved_secret'
}

/** The harnesses whose CLI speaks MCP. Pi has no MCP client, so it is deliberately absent. */
export const MCP_SUPPORTED_HARNESSES: readonly HarnessKind[] = ['claude-code', 'codex']

/**
 * Whether a tool server can run on this harness: its own `harnesses` allow-list when it declared
 * one, else the CLIs that speak MCP at all. A definition may NARROW the default (a server that
 * only makes sense under one CLI) but never widen it — a harness with no MCP client cannot be
 * taught one by a registration.
 */
export function mcpServerSupportsHarness(
  definition: Pick<McpServerDefinition, 'harnesses'>,
  harness: HarnessKind,
): boolean {
  if (!MCP_SUPPORTED_HARNESSES.includes(harness)) return false
  return definition.harnesses ? definition.harnesses.includes(harness) : true
}

/**
 * A valid MCP server id: lowercase alphanumerics, dashes and underscores. The id becomes part of
 * the tool names the CLI exposes (`mcp__<id>__<tool>`) and, for Codex, a TOML table key — so an
 * id with a dot, a space or a quote in it produces either an unmatchable allow-list entry or a
 * malformed config, both of which fail deep inside the CLI rather than at registration.
 */
export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidMcpServerId(id: string): boolean {
  return MCP_SERVER_ID_PATTERN.test(id)
}

/**
 * Whether an HTTP tool server's URL may be dispatched. `https` always; plain `http` ONLY for
 * loopback, because an HTTP server routinely carries a resolved credential in a request header
 * and cleartext on any other host puts that credential on the wire. Loopback is exempt so a
 * server running beside the agent in its own container stays usable without a certificate.
 *
 * Deliberately NOT a general SSRF guard: the URL is deployment-authored composition-root data
 * (an operator naming their own service), not user input, and the request is made by the agent
 * CLI inside the run container rather than by the backend.
 */
export function isAllowedMcpHttpUrl(raw: string): boolean {
  const match = /^(https?):\/\/([^/?#]*)/i.exec(raw)
  if (!match) return false
  if (match[1]!.toLowerCase() === 'https') return true
  // Plain http from here: the host must be loopback. Strip userinfo FIRST and from the LAST `@`,
  // or `http://127.0.0.1@evil.example` reads as loopback while the request goes to evil.example.
  const authority = match[2]!
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const closingBracket = hostPort.indexOf(']')
  const host = (
    hostPort.startsWith('[') && closingBracket !== -1
      ? hostPort.slice(1, closingBracket) // IPv6 literal, e.g. [::1]:8080
      : (hostPort.split(':')[0] ?? '')
  ).toLowerCase()
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}
