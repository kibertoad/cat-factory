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
 * What the agent's CLI reported about ONE wired tool server when it started up.
 *
 * This is the OBSERVED half of the run's tool-server record, and it answers a question the
 * backend's own half structurally cannot: the dispatch record says why the platform WITHHELD a
 * tool, while this says a server the platform wired failed to start anyway. A vendor endpoint
 * that 500s, an `npx` package that no longer resolves, a credential the vendor has since revoked
 * — every one of those leaves the prompt promising a tool the agent then cannot call, and before
 * this the only evidence was the agent saying so in prose, if it noticed at all.
 *
 * OBSERVED, never decided: nothing here changes what the run does. The harness reports what the
 * CLI said and the backend records it beside what it decided; no code path branches on it.
 */
export interface ObservedMcpServer {
  /** The server id the CLI named — the same id the backend declared (`--strict-mcp-config`). */
  id: string
  status: ObservedMcpStatus
  /**
   * How many of the CLI's exposed tools belong to this server (`mcp__<id>__…`).
   *
   * ABSENT and `0` are different facts and both are worth having: absent means this image counted
   * nothing for the server, while `0` means it counted and the server contributed none: a server
   * that connected and exposes nothing, which reads to the agent exactly like a server that was
   * never wired. Never defaulted to 0.
   *
   * Two things leave it absent, and neither is "the server has no tools": the CLI listed no tools
   * at all, or the tool namespace cannot say which of two declared servers a name belongs to (see
   * {@link tallyToolsByServer}).
   */
  toolCount?: number
}

/**
 * The status vocabulary of {@link ObservedMcpServer}, normalised from the CLI's own word.
 *
 * A CLOSED list mapped from an OPEN one, which is why `unknown` is a member rather than a reason
 * to drop the row. The CLI's status strings are a third party's vocabulary and it may add to them;
 * a server whose status this image cannot name is still a server the CLI knows about, and the
 * honest report is "it was there, this image could not read its state" rather than silence
 * (which reads as a server the CLI never mentioned) or a guess at `ready` (which would report a
 * dead tool as a live one, the precise failure the whole unavailability vocabulary exists to
 * prevent).
 *
 * `unknown` covers two causes that share one remedy, which is why they share one member: a word
 * this image cannot map, and a word the CLI uses for a state that is not resolved YET. Neither
 * says anything about the server, and the surface paints neither as a fault.
 */
export type ObservedMcpStatus = 'ready' | 'failed' | 'needs_auth' | 'unknown'

/**
 * Map one status word from the CLI onto {@link ObservedMcpStatus}.
 *
 * The synonyms are grouped rather than listed one-to-one because the CLI has spelled the same
 * two states more than one way across versions (`connected`/`ready`, `failed`/`error`), and an
 * image that pinned the exact spelling would silently start reporting `unknown` for every server
 * on a CLI upgrade — a regression that looks identical to a genuine outage.
 */
function normalizeMcpStatus(value: unknown): ObservedMcpStatus {
  if (typeof value !== 'string') return 'unknown'
  const status = value.trim().toLowerCase()
  if (status === 'connected' || status === 'ready' || status === 'ok') return 'ready'
  if (status === 'failed' || status === 'error') return 'failed'
  // The vendor spells the OAuth-required state with a hyphen; the underscore form costs nothing
  // to accept and is what a JSON-ish vocabulary tends to drift toward.
  if (status === 'needs-auth' || status === 'needs_auth') return 'needs_auth'
  // Everything else, INCLUDING the CLI's `pending`. A server still handshaking when the session
  // was announced has no resolved state, which is exactly what `unknown` says, and `needs_auth` is
  // the tempting wrong guess for it: the surface paints that one amber as "waiting for you to
  // authorize it", sending an operator to re-issue a working credential for a server that was
  // merely slow and came up a second later.
  return 'unknown'
}

/**
 * Read the claude-code CLI's startup report (`{"type":"system","subtype":"init"}`) into one
 * {@link ObservedMcpServer} per server the CLI knows about.
 *
 * The CLI announces its resolved session ONCE, before the first model call: which MCP servers it
 * loaded and with what status, and the flat list of tool names it will expose. Both halves are
 * read here because neither answers the question alone — a `ready` server exposing no tools is as
 * useless to the agent as a failed one, and a tool count with no status cannot say why.
 *
 * Returns `undefined` when the event names no servers at all, which keeps "this run wired none"
 * and "this image observed none" from collapsing into an empty list on the backend's record.
 * Pure, so the parsing is testable without a CLI: {@link runClaudeCode} feeds it the raw event.
 */
export function observeClaudeMcpInit(
  event: Record<string, unknown>,
): ObservedMcpServer[] | undefined {
  if (event.type !== 'system' || event.subtype !== 'init') return undefined
  const reported = event.mcp_servers
  if (!Array.isArray(reported) || reported.length === 0) return undefined
  const rows: { id: string; status: ObservedMcpStatus }[] = []
  const declared = new Set<string>()
  for (const entry of reported) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = sanitizeServerId(record.name)
    // An id this image cannot hold is dropped rather than reported under a mangled name: the
    // whole row is only useful if it JOINS the backend's declaration, and `--strict-mcp-config`
    // means every server the CLI loaded came from the config this harness wrote.
    if (!id || declared.has(id)) continue
    declared.add(id)
    rows.push({ id, status: normalizeMcpStatus(record.status) })
  }
  if (rows.length === 0) return undefined
  // Counted from the CLI's own tool list rather than from a per-server field, because there is no
  // per-server field: the CLI flattens every server's tools into one array namespaced by server
  // id. A missing/non-array list leaves every count ABSENT rather than 0 (see `toolCount`).
  const tally = tallyToolsByServer(event.tools, declared)
  return rows.map((row) => ({
    ...row,
    ...(tally && !tally.ambiguous.has(row.id) ? { toolCount: tally.counts.get(row.id) ?? 0 } : {}),
  }))
}

/** What {@link tallyToolsByServer} read out of the CLI's flat tool list. */
interface ToolTally {
  /** Tools attributed to each declared server. A server with none is simply absent from the map. */
  counts: ReadonlyMap<string, number>
  /**
   * Servers whose count could not be established, because at least one tool name belongs to more
   * than one of them. Their count is reported ABSENT rather than short.
   */
  ambiguous: ReadonlySet<string>
}

/**
 * Tally the CLI's flat tool list (`mcp__<id>__<tool>`) against the servers the SAME event
 * declared, or `undefined` when it carried no list, which is the distinction
 * {@link ObservedMcpServer.toolCount} preserves.
 *
 * Matched against the declared ids rather than split on the first `__`, because the id vocabulary
 * ({@link MCP_SERVER_ID_PATTERN}) permits an underscore: a server named `code__search` owns
 * `mcp__code__search__query`, which a first-separator split files under a server called `code`,
 * leaving the real one reporting `toolCount: 0`. That is the single most diagnostic value on the
 * field, so the mis-split renders a fully healthy server as one that started and exposes nothing.
 *
 * The same underscore makes genuine ambiguity representable: with both `code` and `code__search`
 * declared, `mcp__code__search__query` is a name either could own and nothing in the report says
 * which. Neither server is counted then, and both are named `ambiguous` so their count stays
 * absent. Guessing an owner would move a real tool onto the wrong server and take the other's
 * count to a `0` that reads as a fault.
 */
function tallyToolsByServer(tools: unknown, declared: ReadonlySet<string>): ToolTally | undefined {
  if (!Array.isArray(tools)) return undefined
  const counts = new Map<string, number>()
  const ambiguous = new Set<string>()
  for (const tool of tools) {
    if (typeof tool !== 'string' || !tool.startsWith('mcp__')) continue
    const owners: string[] = []
    for (const id of declared) {
      const prefix = `mcp__${id}__`
      // The tool name after the prefix must be non-empty: `mcp__slack__` names no tool.
      if (tool.length > prefix.length && tool.startsWith(prefix)) owners.push(id)
    }
    const [owner] = owners
    if (owners.length === 1 && owner) counts.set(owner, (counts.get(owner) ?? 0) + 1)
    else for (const id of owners) ambiguous.add(id)
  }
  return { counts, ambiguous }
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
 * The optional job-body CAPABILITY fields this image parses, reported on `/health` and on the
 * `POST /jobs` acceptance so a backend can tell whether the body it just sent will be honoured.
 *
 * The gap it closes: an image older than a capability does not fail on it, it ignores the field.
 * The backend composes the PROMPT, so a dropped `mcpServers` leaves the agent reading that it has
 * tools it has no client for: a blind run rather than a failed one, and previously invisible to
 * the backend, which has no way to know what image a self-hosted runner pool pins.
 *
 * Kept byte-identical to kernel's `HARNESS_BODY_CAPABILITIES` (the image is built from `src/` plus
 * typescript alone, so it can carry no runtime dependency on a workspace package) and pinned
 * against it by `test/agent-capabilities.conformity.test.ts`, the same copy-plus-pin arrangement
 * {@link MCP_SERVER_ID_PATTERN} uses.
 *
 * A member is added here in the SAME change that teaches the parser the field, never ahead of it:
 * the whole value of the list is that it is the image's own honest answer.
 */
export const HARNESS_BODY_CAPABILITIES: readonly string[] = [
  'mcpServers',
  'skills',
  'designImages',
  'generateImages',
]

/**
 * A safe MCP server id: it becomes a tool-name fragment AND a TOML table key.
 *
 * Kept byte-identical to kernel's `MCP_SERVER_ID_PATTERN` (the harness image is built from `src/`
 * plus typescript alone, so it can carry no runtime dependency on a workspace package) and pinned
 * against it by `test/agent-capabilities.conformity.test.ts`, the same copy-plus-pin arrangement
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
 * that survive are what narrows the session: a bad one would silently take the run's whole MCP
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
  // ASCII control characters and the space are refused ANYWHERE rather than canonicalised: the
  // WHATWG parser trims leading/trailing C0-and-space and removes tab, LF and CR from anywhere, so
  // a url carrying one parses to something other than what it reads as, and this url is written
  // VERBATIM into the CLI's MCP config below.
  for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) <= 0x20) return false
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // silent-catch-ok: an unparseable url is exactly what this predicate refuses.
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.protocol === 'https:') return true
  // Plain http from here: the host must be loopback. `new URL` rather than a hand-written parse
  // because it is the parser the CLI resolves the request with, so the host ruled on is the host
  // the credential header travels to. It strips userinfo from the LAST `@` (or
  // `http://127.0.0.1@evil.example` reads as loopback while the request goes to evil.example), and
  // it terminates the authority at a backslash as well as at `/?#` (or
  // `http://evil.example\@127.0.0.1` reads as loopback the same way).
  const hostname = parsed.hostname
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
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
 * absent field (every tool the server exposes) and the right one: the alternative is a list whose
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
