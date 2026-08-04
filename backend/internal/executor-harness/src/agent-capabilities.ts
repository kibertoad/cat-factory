import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// The AGENT CAPABILITIES a job body can carry: the skills the run applies and the tool servers
// (MCP) it may call. This module owns their wire shapes, the (defensive) parsing every job-body
// field gets at the boundary, and the writers that turn a tool-server spec into the config each
// agent CLI reads.
//
// Both are backend-authored data the harness only MATERIALISES — there is no `switch(agentKind)`
// here and no per-capability code path: a new skill or a new tool server is a backend
// registration, never a harness change or an image bump.
// ---------------------------------------------------------------------------

/** One materialisable resource file of a skill. */
export interface SkillResourceSpec {
  /** Path within the skill directory, e.g. `templates/report.md` (subdirs preserved, no traversal). */
  relPath: string
  content: string
}

/**
 * A skill to make available for a run. Materialised HARNESS-AWARE:
 * `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (+ resources) for the claude-code CLI to load
 * natively, or `.cat-context/skill/<name>/<relPath>` for the Pi/codex checkout (their prompt
 * carries the instructions). A dedicated top-level body field, never a context file.
 */
export interface SkillSpec {
  name: string
  description: string
  instructions: string
  resources: SkillResourceSpec[]
}

/**
 * A tool server (MCP) to wire into the agent CLI for this run, with its transport and any
 * credentials the backend resolved. Only the CLIs that speak MCP receive these; the backend has
 * already dropped anything this harness cannot serve, so the harness never has to decide.
 *
 * The values here are SECRET-BEARING (`env` / `headers` carry resolved credentials), which is why
 * the config files this module writes always live outside the checkout and are never logged.
 */
export interface McpServerSpec {
  /** The server name the CLI exposes tools under (`mcp__<id>__<tool>`). Id-safe by construction. */
  id: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Bare tool names the agent may call. Absent ⇒ every tool the server exposes. */
  allowedTools?: string[]
  /**
   * Which keys of `env` / `headers` hold a RESOLVED CREDENTIAL rather than declared configuration.
   * {@link mcpServerSecretValues} reads exactly these for redaction — scrubbing the whole map
   * instead would turn every later occurrence of an ordinary config string into `***`.
   */
  secretKeys?: string[]
}

/**
 * The credential values carried by a run's tool servers, for {@link registerKnownSecrets}. An MCP
 * server that fails to start routinely echoes its own argv or request headers into stderr, and
 * that tail reaches the step's diagnostics — so these have to be scrubbed exactly like the leased
 * subscription token. Only the keys the backend MARKED as secret are read (see `secretKeys`).
 */
export function mcpServerSecretValues(servers: readonly McpServerSpec[]): string[] {
  const values: string[] = []
  for (const server of servers) {
    for (const key of server.secretKeys ?? []) {
      const value = server.env?.[key] ?? server.headers?.[key]
      if (value) values.push(value)
    }
  }
  return values
}

// ---------------------------------------------------------------------------
// Parsing (the job-body boundary)
// ---------------------------------------------------------------------------

/**
 * Sanitize a skill resource's relative path: keep the subdirectory structure (so
 * `templates/report.md` materialises nested) but reject anything that could escape the skill
 * directory — absolute paths, `..` traversal, backslashes, empty/dot segments. Returns undefined
 * for an unsafe path (the resource is then dropped).
 */
function sanitizeSkillRelPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const segments = value.replace(/\\/g, '/').split('/')
  const clean: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return undefined
    // Same character class as a context-file name, per segment.
    const c = seg.replace(/[^A-Za-z0-9._-]/g, '')
    if (!c || c === '.' || c === '..' || c.startsWith('.')) return undefined
    clean.push(c)
  }
  return clean.length ? clean.join('/') : undefined
}

/**
 * Fallback native-skill directory name when the authored name has no id-safe characters (e.g. a
 * purely non-ASCII skill name). The name is only a path segment / manifest label, so a safe
 * default keeps the skill installable rather than dropping it — which, on the claude-code path,
 * would leave the prompt pointing at a skill that was never installed (a blind run).
 */
const FALLBACK_SKILL_NAME = 'skill'

/** A skill's own directory name, sanitized to a safe single path segment (undefined if empty). */
function sanitizeSkillName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const base = value.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return undefined
  return cleaned
}

/** Validate one entry of the `skills` field, or undefined when malformed. */
function parseSkillSpec(value: unknown): SkillSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const instructions = typeof o.instructions === 'string' ? o.instructions : undefined
  // No instructions ⇒ there is nothing to run — drop the skill (the prompt still carries the
  // folded-in directive on the Pi/codex path). An unsafe/empty NAME only affects the install
  // directory, so fall back to a safe default rather than dropping the whole skill.
  if (!instructions) return undefined
  const name = sanitizeSkillName(o.name) ?? FALLBACK_SKILL_NAME
  const description = typeof o.description === 'string' ? o.description : ''
  const resources: SkillResourceSpec[] = []
  if (Array.isArray(o.resources)) {
    const used = new Set<string>()
    for (const entry of o.resources) {
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const relPath = sanitizeSkillRelPath(e.relPath)
      if (!relPath || used.has(relPath)) continue
      if (typeof e.content !== 'string') continue
      used.add(relPath)
      resources.push({ relPath, content: e.content })
    }
  }
  return { name, description, instructions, resources }
}

/**
 * Validate the optional `skills` field. Names are de-duplicated: two skills sharing a directory
 * name would overwrite each other's `SKILL.md`, leaving the agent pointed at whichever landed
 * last — so the first wins and the collision is dropped rather than silently mixing two playbooks.
 */
export function parseSkillSpecs(value: unknown): SkillSpec[] | undefined {
  if (!Array.isArray(value)) return undefined
  const skills: SkillSpec[] = []
  const used = new Set<string>()
  for (const entry of value) {
    const skill = parseSkillSpec(entry)
    if (!skill || used.has(skill.name)) continue
    used.add(skill.name)
    skills.push(skill)
  }
  return skills.length ? skills : undefined
}

/**
 * A safe MCP server id: it becomes a tool-name fragment AND a TOML table key.
 *
 * Kept byte-identical to kernel's `MCP_SERVER_ID_PATTERN` (the harness image is built from `src/`
 * plus typescript alone, so it can carry no runtime dependency on a workspace package) and pinned
 * against it by `test/agent-capabilities.conformity.test.ts` — the same copy-plus-pin arrangement
 * `src/host-markdown.ts` uses.
 */
export const MCP_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

function sanitizeServerId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return MCP_SERVER_ID_PATTERN.test(value) ? value : undefined
}

/**
 * A tool name an `allowedTools` entry may name. Kept byte-identical to kernel's
 * `MCP_TOOL_NAME_PATTERN` for the same reason {@link MCP_SERVER_ID_PATTERN} is a copy, and pinned
 * against it by `test/agent-capabilities.conformity.test.ts`.
 *
 * The comma is the reason the rule exists on THIS side of the boundary too:
 * {@link claudeAllowedToolPatterns} builds the list that the runner joins into one
 * `--allowedTools` argument with commas, so an entry carrying one splits into two patterns of which
 * the second matches no tool the CLI has. Dropped rather than passed through, because the entries
 * that survive are what narrows the session — a bad one would silently take the run's whole MCP
 * surface with it.
 */
export const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Whether an HTTP tool server's URL may be started. Mirrors kernel's `isAllowedMcpHttpUrl` (see
 * {@link MCP_SERVER_ID_PATTERN} for why it is a copy, and the conformity suite that pins it):
 * `https` anywhere, plain `http` only on loopback, since the headers carry a resolved credential.
 * The backend refuses the same URLs at registration — this is the boundary check, so a body that
 * reached the container by any other route is held to the rule too.
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

/** A string→string record, dropping any non-string entry. Undefined when nothing survives. */
function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
  }
  return Object.keys(out).length ? out : undefined
}

/** A string array, dropping non-string entries. Undefined when nothing survives. */
function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length ? out : undefined
}

/**
 * The `allowedTools` list: string entries that are single tool NAMES (see
 * {@link MCP_TOOL_NAME_PATTERN}). Undefined when nothing survives, which is the same answer as an
 * absent field — every tool the server exposes — and the right one: the alternative is a list whose
 * only surviving entries are the platform's own built-in tool names, i.e. a run narrowed to no MCP
 * tools at all. The backend refuses these at registration; this is the boundary check.
 */
function parseAllowedTools(value: unknown): string[] | undefined {
  const names = parseStringArray(value)?.filter((name) => MCP_TOOL_NAME_PATTERN.test(name))
  return names?.length ? names : undefined
}

/** Validate one `mcpServers` entry, or undefined when malformed for its transport. */
function parseMcpServerSpec(value: unknown): McpServerSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const id = sanitizeServerId(o.id)
  if (!id) return undefined
  const allowedTools = parseAllowedTools(o.allowedTools)
  const secretKeys = parseStringArray(o.secretKeys)
  if (o.transport === 'http') {
    // https anywhere, plain http only on loopback: the CLI would happily be pointed at a
    // `file:`/`ws:` URL, and the headers below carry this job's resolved credential.
    const url = typeof o.url === 'string' && isAllowedMcpHttpUrl(o.url) ? o.url : undefined
    if (!url) return undefined
    const headers = parseStringRecord(o.headers)
    return {
      id,
      transport: 'http',
      url,
      ...(headers ? { headers } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(secretKeys ? { secretKeys } : {}),
    }
  }
  const command = typeof o.command === 'string' && o.command ? o.command : undefined
  if (!command) return undefined
  const args = parseStringArray(o.args)
  const env = parseStringRecord(o.env)
  return {
    id,
    transport: 'stdio',
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(secretKeys ? { secretKeys } : {}),
  }
}

/** Validate the optional `mcpServers` field, dropping malformed entries and duplicate ids. */
export function parseMcpServerSpecs(value: unknown): McpServerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined
  const servers: McpServerSpec[] = []
  const used = new Set<string>()
  for (const entry of value) {
    const server = parseMcpServerSpec(entry)
    if (!server || used.has(server.id)) continue
    used.add(server.id)
    servers.push(server)
  }
  return servers.length ? servers : undefined
}

// ---------------------------------------------------------------------------
// Materialisation (per CLI)
// ---------------------------------------------------------------------------

/**
 * The `--mcp-config` document Claude Code reads: `{ "mcpServers": { "<id>": {...} } }`. An `http`
 * server declares `type: "http"` with its headers; a `stdio` one declares its command/args/env.
 */
export function claudeMcpConfig(servers: McpServerSpec[]): {
  mcpServers: Record<string, Record<string, unknown>>
} {
  const mcpServers: Record<string, Record<string, unknown>> = {}
  for (const server of servers) {
    mcpServers[server.id] =
      server.transport === 'http'
        ? { type: 'http', url: server.url, ...(server.headers ? { headers: server.headers } : {}) }
        : {
            type: 'stdio',
            command: server.command,
            ...(server.args ? { args: server.args } : {}),
            ...(server.env ? { env: server.env } : {}),
          }
  }
  return { mcpServers }
}

/**
 * The claude-code CLI's own tools, named so an `--allowedTools` list can never take them away.
 *
 * An allow-list is whole-session: it does not scope itself to MCP just because every entry we
 * generate happens to be an `mcp__*` pattern. So the moment one tool server narrows its tools, the
 * list has to re-grant the agent's built-in file/bash/search tools or the run is handed a narrowed
 * MCP surface AND no way to read, edit or build anything.
 *
 * Bias this list toward OVER-inclusion. A name the CLI does not have is inert; a name it has and
 * this list lacks is a tool silently removed from a run — which surfaces as an agent that cannot
 * do its work, far from the registration that caused it. Historical/renamed spellings are kept for
 * the same reason: the harness image is pinned per workspace, so one image faces several CLI
 * versions. When the CLI gains a tool, add it here.
 */
export const CLAUDE_BUILT_IN_TOOLS: readonly string[] = [
  'Agent',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillBash',
  'KillShell',
  'ListMcpResources',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Read',
  'ReadMcpResource',
  'SlashCommand',
  'Skill',
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]

/**
 * The tool-name list for `--allowedTools`: every declared server's tools in the CLI's
 * `mcp__<server>__<tool>` convention, PLUS {@link CLAUDE_BUILT_IN_TOOLS}. A server with no
 * restriction contributes the whole-server pattern, so an allow-list stays one entry per server.
 *
 * Returns undefined when NO server restricts its tools — there is then nothing to narrow, and the
 * safest list is the one we never send.
 *
 * Whether the CLI ENFORCES this list is permission-mode dependent and not a contract we control:
 * the run uses `--permission-mode bypassPermissions` (the container is the sandbox and no human is
 * there to approve a call), under which an allow-list grants rather than gates. So this is written
 * to be correct under BOTH readings — if the list gates, the narrowing is real and the built-ins
 * survive it; if it is inert, sending it costs nothing. The always-present channel is the PROMPT,
 * which states each server's permitted tool names on every harness. Treat `allowedTools` as
 * scoping, not as a security boundary: a server the agent must not reach fully should not be
 * wired for that kind at all.
 */
export function claudeAllowedToolPatterns(servers: McpServerSpec[]): string[] | undefined {
  if (!servers.some((s) => s.allowedTools?.length)) return undefined
  const mcp = servers.flatMap((s) =>
    s.allowedTools?.length ? s.allowedTools.map((t) => `mcp__${s.id}__${t}`) : [`mcp__${s.id}`],
  )
  return [...mcp, ...CLAUDE_BUILT_IN_TOOLS]
}

/** Escape a string as a TOML basic string (Codex config is TOML, not JSON). */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * The `[mcp_servers.<id>]` TOML block Codex reads from its `CODEX_HOME/config.toml`. Codex's MCP
 * client is stdio-only, so an `http` server is skipped here.
 *
 * The skip is now a BACKSTOP rather than the decision: the backend knows which transports each
 * harness reaches (`MCP_HARNESS_TRANSPORTS`) and drops an `http` server from a Codex dispatch under
 * its own `transport_unsupported` reason, so the prompt states the gap instead of advertising a tool
 * this writer then silently omitted. It stays because a body that reached the container by any other
 * route must still produce a valid config rather than a malformed one.
 */
export function codexMcpConfigToml(servers: McpServerSpec[]): string {
  const blocks: string[] = []
  for (const server of servers) {
    if (server.transport !== 'stdio') continue
    const lines = [`[mcp_servers.${server.id}]`, `command = ${tomlString(server.command!)}`]
    if (server.args?.length) {
      lines.push(`args = [${server.args.map(tomlString).join(', ')}]`)
    }
    if (server.env) {
      const entries = Object.entries(server.env).map(
        ([k, v]) => `${tomlString(k)} = ${tomlString(v)}`,
      )
      if (entries.length) lines.push(`env = { ${entries.join(', ')} }`)
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.length ? `${blocks.join('\n\n')}\n` : ''
}

/**
 * Write the Claude Code MCP config for this run and return its path, or undefined when there are
 * no servers. The file is written into the caller's PER-RUN directory (an isolated config home, or
 * an ambient job's own scratch dir) — never the checkout (it would land in a commit) and never a
 * HOME-global path (a second concurrent job would clobber it, and it carries this job's credentials).
 */
export async function writeClaudeMcpConfig(
  dir: string,
  servers: McpServerSpec[],
): Promise<string | undefined> {
  if (!servers.length) return undefined
  const path = join(dir, 'mcp-servers.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(claudeMcpConfig(servers), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return path
}
