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

/** A safe MCP server id: it becomes a tool-name fragment AND a TOML table key. */
function sanitizeServerId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) ? value : undefined
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

/** Validate one `mcpServers` entry, or undefined when malformed for its transport. */
function parseMcpServerSpec(value: unknown): McpServerSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const id = sanitizeServerId(o.id)
  if (!id) return undefined
  if (o.transport === 'http') {
    // Only http(s): the CLI would happily be pointed at a `file:`/`ws:` URL, and the backend is
    // the only thing that has vetted this string.
    const url = typeof o.url === 'string' && /^https?:\/\//.test(o.url) ? o.url : undefined
    if (!url) return undefined
    return {
      id,
      transport: 'http',
      url,
      ...(parseStringRecord(o.headers) ? { headers: parseStringRecord(o.headers)! } : {}),
      ...(parseStringArray(o.allowedTools)
        ? { allowedTools: parseStringArray(o.allowedTools)! }
        : {}),
    }
  }
  const command = typeof o.command === 'string' && o.command ? o.command : undefined
  if (!command) return undefined
  return {
    id,
    transport: 'stdio',
    command,
    ...(parseStringArray(o.args) ? { args: parseStringArray(o.args)! } : {}),
    ...(parseStringRecord(o.env) ? { env: parseStringRecord(o.env)! } : {}),
    ...(parseStringArray(o.allowedTools)
      ? { allowedTools: parseStringArray(o.allowedTools)! }
      : {}),
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
 * The tool-name patterns for `--allowedTools`, in the CLI's `mcp__<server>__<tool>` convention.
 * A server with no restriction contributes the whole-server pattern, so an allow-list stays one
 * entry per server.
 *
 * Returns undefined when NO server restricts its tools: passing an allow-list at all switches the
 * CLI into allow-list mode for every tool it has, which would silently strip the agent of its
 * built-in file/bash tools — the flag is only safe to send when it is actually narrowing MCP.
 */
export function claudeAllowedToolPatterns(servers: McpServerSpec[]): string[] | undefined {
  if (!servers.some((s) => s.allowedTools?.length)) return undefined
  return servers.flatMap((s) =>
    s.allowedTools?.length ? s.allowedTools.map((t) => `mcp__${s.id}__${t}`) : [`mcp__${s.id}`],
  )
}

/** Escape a string as a TOML basic string (Codex config is TOML, not JSON). */
function tomlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * The `[mcp_servers.<id>]` TOML block Codex reads from its `CODEX_HOME/config.toml`. Codex's MCP
 * client is stdio-only, so an `http` server is skipped here — the backend states such a server as
 * unavailable when it declares `harnesses: ['claude-code']`, and a deployment that wires an HTTP
 * server for Codex gets a no-op rather than a malformed config.
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
