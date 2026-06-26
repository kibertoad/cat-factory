import { spawn } from 'node:child_process'
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { killChildProcess } from './process.js'
import { redactSecrets } from './redact.js'

// Drives the Pi coding-agent CLI. Pi is pointed at the Worker's OpenAI-compatible
// proxy via a custom provider in ~/.pi/agent/models.json, authenticated with the
// per-job session token (interpolated from $PI_PROXY_TOKEN) — so no provider key
// ever lives in the image or in Pi's config on disk.

/**
 * Per-completion output-token ceiling Pi requests (its model-entry `maxTokens`).
 * Generous on purpose: a reasoning model (e.g. GLM-5.2) spends tokens on its
 * `<think>` trace before the answer + tool calls, so a tight cap truncates it
 * mid-reasoning and the agent never commits edits. It is a ceiling, not a target
 * — unused output tokens are not billed and Workers AI clamps the request to the
 * model's real max — so erring high is safe. Raised to 32k after a spec-writer run
 * truncated an intermediate tool call at the old 16k cap; the document itself
 * stopped well under it, so this is headroom for larger specs/diffs, with
 * {@link runDiagnostics} flagging the rare case where even 32k is not enough.
 */
export const PI_MAX_OUTPUT_TOKENS = 32_768

/** Write the Pi provider config that routes all model calls through the proxy. */
export async function writePiModelsConfig(opts: {
  model: string
  proxyBaseUrl: string
  /** Output-token ceiling Pi may request per completion. Defaults to PI_MAX_OUTPUT_TOKENS. */
  maxTokens?: number
}): Promise<string> {
  const dir = join(homedir(), '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  const config = {
    providers: {
      proxy: {
        baseUrl: opts.proxyBaseUrl,
        api: 'openai-completions',
        // Interpolated by Pi from the environment at run time.
        apiKey: '$PI_PROXY_TOKEN',
        // OpenAI-compatible upstreams behind the proxy don't all accept the
        // `developer` role or `reasoning_effort`; send a plain system message.
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        // `maxTokens` is Pi's per-completion output ceiling — set it generously so
        // a reasoning model isn't cut off mid-think (see PI_MAX_OUTPUT_TOKENS).
        models: [
          { id: opts.model, name: opts.model, maxTokens: opts.maxTokens ?? PI_MAX_OUTPUT_TOKENS },
        ],
      },
    },
  }
  const path = join(dir, 'models.json')
  await writeFile(path, JSON.stringify(config, null, 2), 'utf8')
  return path
}

// Appended to every AGENTS.md so the model maintains the `todo` tool the image
// installs (rpiv-todo). Without a nudge a model may skip the tool, which would
// leave the run with no subtask progress to report; keeping the list current is
// what makes the board's "N/M done" move.
const TODO_GUIDANCE = `

## Progress tracking (required)

You have a \`todo\` tool. For any multi-step task, before you start coding, break
the work into concrete subtasks with \`todo\` (action "create"). As you work, mark
each one \`in_progress\` when you begin it and \`completed\` when it's done (action
"update"). Keep the list accurate — it is the only signal the system has for how
far along the run is.`

// Appended to AGENTS.md only when the rpiv-web-tools extension is configured (an
// active web-search provider is set — see `webSearchConfigFromEnv`). Without a
// nudge a model rarely reaches for the tools, so it would keep relying on stale
// training data. Kept deliberately conservative: search is for facts that genuinely
// change or that the agent is unsure of, NOT a substitute for reading the repo.
const WEB_TOOLS_GUIDANCE = `

## Web search & fetch (use sparingly)

You have \`web_search\` (returns titled result snippets for a query) and \`web_fetch\`
(reads a URL as text) tools. Reach for them ONLY when the repository itself can't
answer the question: to confirm a current library/API signature, a breaking change,
an exact error message, or a security advisory. Prefer first-party documentation,
and cite the source URL when a decision rests on what you found. Do NOT browse for
anything already discoverable in the checkout, and don't let searching replace
reading the code.`

// Appended to every AGENTS.md so an agent orients off the persisted service
// blueprint before touching code, but stays shallow by default: read the
// high-level overview first, and only open a module's deep-dive when the task
// actually touches it. Harmless when no blueprint exists yet (e.g. a fresh
// bootstrap) — the files simply aren't there to read.
const BLUEPRINT_GUIDANCE = `

## Service blueprint (read first, stay shallow)

If a \`blueprints/\` folder exists, it is the map of this service. **Before you start,
read \`blueprints/overview.md\`** for the high-level structure (the service and its
modules). Do NOT read every module file. Only open \`blueprints/modules/<name>.md\`
for a module that is directly relevant to your task, when you need its summary and
exact code references. \`blueprints/version.json\` is a tiny manifest for quick
staleness checks. Treat the blueprint as orientation, not a task list.`

// Appended to every AGENTS.md so an agent treats the persisted spec as the
// PRESCRIPTIVE source (what must be true) and the acceptance scenarios its work must
// satisfy. Harmless when no spec exists yet — the files simply aren't there.
const SPEC_GUIDANCE = `

## Service specification (the prescriptive spec)

If a \`spec/\` folder exists, it is the specification for this service. It is sharded
by a module (domain) → feature (group) taxonomy. **Read \`spec/overview.md\` first** —
it states what MUST be true and indexes the modules and their features (with links).
Open \`spec/modules/<module>/<feature>.md\` (or its \`.json\` for exact detail) for the
feature you are working on — it carries that feature's requirements AND the domain
rules scoped to it. \`spec/features/<module>/<feature>.feature\` are the Gherkin
acceptance scenarios your work must satisfy — treat them as the source of truth for
behaviour and tests. Read only the modules/features relevant to your task.`

/**
 * Write the composed system prompt as Pi's GLOBAL agent context
 * (`~/.pi/agent/AGENTS.md`), which Pi reads automatically and concatenates with
 * any `AGENTS.md`/`CLAUDE.md` the repo itself ships (global file first, then the
 * ones walked up from the run cwd). Deliberately OUTSIDE the checkout (the same
 * `~/.pi/agent` dir `writePiModelsConfig` already uses) so the harness's
 * instructions never enter the git working tree — they can't be committed into a
 * PR and they never clobber a repo's own committed `AGENTS.md`.
 *
 * This relies on Pi's context-file resolution: the global `~/.pi/agent/AGENTS.md`
 * is loaded before the project-trust decision, so it applies in non-interactive
 * (`-p`) runs without a trust prompt. That contract is pinned by `PI_VERSION` in
 * the Dockerfile — revisit this if that bump changes context-file resolution.
 */
export async function writeAgentsContext(
  systemPrompt: string,
  opts: {
    webSearch?: boolean
    guidance?: string
    serviceDirectory?: string
    contextFiles?: ContextFileInfo[]
  } = {},
): Promise<void> {
  const dir = join(homedir(), '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  // Only nudge towards the web tools when they're actually configured, so an agent is
  // never told about tools that would error (no provider key) the moment it calls them.
  // `guidance` is the backend's per-kind nudge; fall back to the generic blurb for jobs
  // that don't carry one (e.g. bootstrap, or an older dispatcher).
  const webTools = opts.webSearch ? (opts.guidance ?? WEB_TOOLS_GUIDANCE) : ''
  // Tell the agent it's in a monorepo and which subtree is its service, so it scopes
  // its work (and its build/test commands) there. Only present when the dispatcher
  // resolved a monorepo service directory; the agent's cwd already points at it.
  const monorepo = opts.serviceDirectory ? monorepoGuidance(opts.serviceDirectory) : ''
  // Point the agent at any linked context the backend materialised into the checkout
  // (requirements / RFCs / PRDs / tracker issues) so it reads them on demand.
  const context = contextGuidance(opts.contextFiles ?? [])
  await writeFile(
    join(dir, 'AGENTS.md'),
    `${systemPrompt}${BLUEPRINT_GUIDANCE}${SPEC_GUIDANCE}${TODO_GUIDANCE}${monorepo}${webTools}${context}`,
    'utf8',
  )
}

/** Directory in the checkout where linked-context files are materialised (see CONTEXT_DIR in agents). */
export const CONTEXT_DIR = '.cat-context'

/** The metadata the AGENTS.md context block needs to point an agent at a materialised file. */
export interface ContextFileInfo {
  path: string
  title: string
  url: string
  content: string
}

/** The AGENTS.md block enumerating the materialised linked-context files, or '' when none. */
function contextGuidance(files: ContextFileInfo[]): string {
  if (!files.length) return ''
  const list = files
    .map((f) => `- \`${CONTEXT_DIR}/${f.path}\` — ${f.title}${f.url ? ` (${f.url})` : ''}`)
    .join('\n')
  return `

## Linked context (read on demand)
Requirements / RFCs / PRDs / tracker issues relevant to this task are in the \`${CONTEXT_DIR}/\`
directory of your checkout. Open a file when it is relevant. Do NOT attempt to reach external
systems (Jira / Confluence / GitHub) — everything available has already been placed on disk:
${list}`
}

/**
 * Write the backend-prepared linked-context files into {@link CONTEXT_DIR} in the
 * checkout so the agent can read them on demand, and add a LOCAL git exclude entry so
 * even `git add -A` never commits them into the agent's PR. Best-effort on the exclude
 * (a scaffold-from-scratch checkout has no `.git` yet — the files just stay untracked).
 */
export async function materializeContextFiles(
  cwd: string,
  files: ContextFileInfo[],
): Promise<void> {
  if (!files.length) return
  const dir = join(cwd, CONTEXT_DIR)
  await mkdir(dir, { recursive: true })
  for (const f of files) await writeFile(join(dir, f.path), f.content, 'utf8')
  // The exclude pattern has no leading slash, so it matches `.cat-context/` at any depth
  // — covering the monorepo case where cwd is a service subdirectory below the repo root.
  // Walk up to find the repo's `.git` (best-effort; a from-scratch scaffold has none).
  const gitRoot = await findGitRoot(cwd)
  if (!gitRoot) return
  try {
    await appendFile(join(gitRoot, '.git', 'info', 'exclude'), `\n${CONTEXT_DIR}/\n`, 'utf8')
  } catch {
    // No writable .git/info; the files simply stay untracked (still not auto-added on most flows).
  }
}

/** Walk up from `dir` (bounded) to the directory containing a `.git` folder, or null. */
async function findGitRoot(dir: string): Promise<string | null> {
  let current = dir
  for (let i = 0; i < 8; i++) {
    if (await pathExists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The monorepo note appended to AGENTS.md when a run is scoped to a service subdirectory. */
function monorepoGuidance(serviceDirectory: string): string {
  return `

## Monorepo service (work within your subdirectory)

This repository is a **monorepo** hosting more than one service. The service you are
working on lives in \`${serviceDirectory}/\` (relative to the repo root), and your
working directory is already set there. Confine your changes to that subtree — create
and edit files under \`${serviceDirectory}/\`, and run that service's own build/test/lint
commands (defined by the manifest in \`${serviceDirectory}/\`, e.g. its \`package.json\`).
Do not modify other services' directories, and only touch shared/root files (workspace
manifests, root config) when the task genuinely requires it.`
}

/**
 * The active web-search backend for the rpiv-web-tools extension. Only the
 * provider id is persisted to disk: the per-provider credential (and any base URL
 * — `SEARXNG_URL`, `OLLAMA_HOST`) is read by the extension straight from the
 * environment, so no key is ever written to the container's filesystem.
 */
export interface WebSearchConfig {
  /** rpiv-web-tools provider id, e.g. `brave`, `tavily`, `exa`, `searxng`. */
  provider: string
}

/**
 * The env var whose presence configures each rpiv-web-tools provider, in selection
 * priority order. Used to AUTO-ENABLE web search whenever a deployment has wired up
 * a provider — there's no separate on/off flag, mirroring how Claude Code / Codex
 * turn search on once a backend is configured. `brave` leads (it's what Claude Code
 * uses); the self-hosted backends (searxng/ollama) come last. For the keyless
 * backends it is the base-URL var that signals "configured".
 */
const WEB_SEARCH_PROVIDER_ENV: ReadonlyArray<{ provider: string; envVar: string }> = [
  { provider: 'brave', envVar: 'BRAVE_SEARCH_API_KEY' },
  { provider: 'tavily', envVar: 'TAVILY_API_KEY' },
  { provider: 'exa', envVar: 'EXA_API_KEY' },
  { provider: 'serper', envVar: 'SERPER_API_KEY' },
  { provider: 'perplexity', envVar: 'PERPLEXITY_API_KEY' },
  { provider: 'youcom', envVar: 'YOUCOM_API_KEY' },
  { provider: 'jina', envVar: 'JINA_API_KEY' },
  { provider: 'firecrawl', envVar: 'FIRECRAWL_API_KEY' },
  { provider: 'searxng', envVar: 'SEARXNG_URL' },
  { provider: 'ollama', envVar: 'OLLAMA_HOST' },
]

/**
 * Resolve the web-search configuration from the environment, or undefined when no
 * provider is configured (⇒ the harness writes no rpiv-web-tools config and never
 * nudges the agent towards the tools, so runs behave exactly as before). Enablement
 * is CONDITIONAL on a provider being configured: if any provider's credential/URL
 * env var is present, web search turns on with that provider (highest-priority one
 * when several are set). `WEB_SEARCH_PROVIDER` is an explicit override that pins the
 * active provider regardless of detection — but only when that provider's own
 * credential/URL is also present, so a pin without a key never nudges the agent
 * towards a tool that would error the moment it's called. No key passes through here
 * — the extension reads each provider's own env var directly.
 */
export function webSearchConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchConfig | undefined {
  const explicit = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase()
  if (explicit) {
    // A pinned provider still needs its credential/URL present. For a provider we
    // know the env var for, require it; an unknown provider id is taken on trust
    // (its env var isn't in our table, so we can't validate it).
    const known = WEB_SEARCH_PROVIDER_ENV.find((p) => p.provider === explicit)
    if (known && !env[known.envVar]?.trim()) return undefined
    return { provider: explicit }
  }
  for (const { provider, envVar } of WEB_SEARCH_PROVIDER_ENV) {
    if (env[envVar]?.trim()) return { provider }
  }
  return undefined
}

/**
 * The env that points the rpiv-web-tools SearXNG provider at the backend's
 * search proxy: `SEARXNG_URL` = `${proxyBaseUrl}/web-search` (the controller mounted
 * under the LLM proxy's `/v1`), and `SEARXNG_API_KEY` = the per-job session token,
 * which the proxy verifies exactly like the LLM proxy. Handed to Pi's child via
 * `runPi`'s `extraEnv`, so the search key never has to enter the sandbox — the search
 * runs server-side under the deployment's own provider key.
 */
export function webSearchProxyEnv(
  proxyBaseUrl: string,
  sessionToken: string,
): { SEARXNG_URL: string; SEARXNG_API_KEY: string } {
  return {
    SEARXNG_URL: `${proxyBaseUrl.replace(/\/+$/, '')}/web-search`,
    SEARXNG_API_KEY: sessionToken,
  }
}

/**
 * Select the active rpiv-web-tools provider by writing
 * `~/.config/rpiv-web-tools/config.json` (the file the extension reads, falling
 * back to `brave` when `provider` is absent). Only the provider id is written —
 * credentials and base URLs come from the environment (env wins over the file in
 * the extension's own resolution order), so no secret is committed to disk. Written
 * 0600 to match the extension's own permissions for that path.
 */
export async function writeWebToolsConfig(config: WebSearchConfig): Promise<string> {
  const dir = join(homedir(), '.config', 'rpiv-web-tools')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'config.json')
  await writeFile(path, JSON.stringify({ provider: config.provider }, null, 2), { mode: 0o600 })
  return path
}

/** One entry of the agent's todo list — its subject and current status. */
export interface TodoItem {
  /** The task's subject text, as the agent wrote it. */
  label: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** Live subtask progress derived from Pi's `todo` tool — e.g. "3/8 done". */
export interface TodoProgress {
  /** Tasks marked completed. */
  completed: number
  /** Tasks currently being worked (rpiv-todo's `in_progress` status). */
  inProgress: number
  /** Total live tasks (tombstoned/deleted tasks excluded). */
  total: number
  /**
   * The individual live tasks (label + status), in list order — so the board can
   * render the actual task list, not just the count. Absent for the simpler
   * `todos[].done` fallback shape, which carries no per-task subject.
   */
  items?: TodoItem[]
}

/**
 * One tool invocation in Pi's loop, captured for the run's observability trace.
 * Metadata only (name + timing + ok) — never the tool's args or result — so the
 * harness buffer stays tiny. The backend drains these on its existing job poll and
 * emits them as child spans under the run trace.
 */
export interface ToolSpan {
  tool: string
  /** Epoch ms the tool call started (approximated as the previous tool's end). */
  startedAt: number
  /** Epoch ms the tool call ended (when its `tool_execution_end` event arrived). */
  endedAt: number
  ok: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * What the agent actually did this run, independent of any file changes. Used to
 * tell a genuine no-op (the agent never reached the model / never acted) apart
 * from a real run, so a bootstrap that produced nothing is failed rather than
 * pushed as an empty repo. `toolCalls === 0 && assistantChars === 0` is the
 * signature of a run where Pi never made a successful model call.
 */
export interface PiRunStats {
  /** Tool calls the assistant emitted across the transcript (0 ⇒ it never acted). */
  toolCalls: number
  /** Total characters of assistant text (0 ⇒ the model produced nothing). */
  assistantChars: number
}

/**
 * Output-quality signals lifted from the agent's transcript, so the harness can fail
 * LOUDLY on a malformed run instead of silently handing a half-baked artifact to the
 * structured-output repair (which would manufacture a doc from garbage — the trap
 * behind the spec-writer ⇄ companion rework loop). Two distinct invalid states, both
 * seen in production from `kimi-k2.7-code`:
 *  - a completion that hit the output ceiling (its answer/tool call was cut off), and
 *  - a FINAL turn that carried no text at all (an empty `content: []` despite spending
 *    output tokens), so there is no answer to parse.
 */
export interface RunDiagnostics {
  /** Some completion ended at the output-token ceiling — its content was cut off. */
  truncated: boolean
  /** The agent's FINAL completion hit the ceiling: its ANSWER (not a mid-run step) was cut off. */
  finalTruncated: boolean
  /** The agent's final turn carried no text content (e.g. an empty `content: []`). */
  finalAnswerEmpty: boolean
}

/** Pi's assistant summary plus {@link PiRunStats} describing what it did. */
export interface PiRunOutcome {
  summary: string
  stats: PiRunStats
  /**
   * Tail of Pi's stderr (credential-scrubbed), captured even on a clean exit.
   * On a no-op run this is where the real cause shows up — e.g. an unreachable
   * proxy or a model the upstream rejected — so the failure is diagnosable
   * without shelling into the (ephemeral) container.
   */
  stderrTail?: string
  /**
   * Token usage lifted from the agent CLI's own event stream. Reported by the
   * subscription harnesses (Claude Code / Codex), whose traffic bypasses the LLM
   * proxy — so the backend folds it into the leased token's rolling-window counters
   * (usage-aware rotation) and telemetry. Absent for the proxy-metered Pi harness.
   */
  usage?: { inputTokens: number; outputTokens: number }
  /** Output-quality signals (truncation / empty final answer); see {@link RunDiagnostics}. */
  diagnostics?: RunDiagnostics
}

/**
 * Pull the `todo` tool's result `details` out of a Pi `--mode json` event, or
 * undefined if the event isn't a successful `todo` tool result.
 *
 * The same tool result surfaces on the stream as two raw agent events, both of
 * which we read (whichever Pi emits/orders first wins; the counts are identical):
 *   - `message_end` with a `toolResult` message — `message.details`
 *   - `tool_execution_end` — `result.details`
 * A top-level `tool_result` shape is also accepted defensively. Pi has no
 * built-in todo tool, so this only ever matches the installed extension's calls.
 */
function todoResultDetails(event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'message_end' && isObject(event.message)) {
    const m = event.message
    if (
      m.role === 'toolResult' &&
      m.toolName === 'todo' &&
      m.isError !== true &&
      isObject(m.details)
    ) {
      return m.details
    }
    return undefined
  }
  if (event.type === 'tool_execution_end' && event.toolName === 'todo' && event.isError !== true) {
    return isObject(event.result) && isObject(event.result.details)
      ? event.result.details
      : undefined
  }
  if (event.type === 'tool_result' && event.toolName === 'todo' && event.isError !== true) {
    return isObject(event.details) ? event.details : undefined
  }
  return undefined
}

/**
 * Derive {@link TodoProgress} from a single Pi `--mode json` event, or undefined
 * if the event isn't a successful `todo` tool result we can read.
 *
 * Pi has no built-in todo tool; the image installs the `@juicesharp/rpiv-todo`
 * extension, whose every successful call returns `details.tasks[]` with a
 * per-task `status` (pending | in_progress | completed | deleted). We also accept
 * the simpler `details.todos[].done` shape of Pi's bundled example extension, so
 * swapping the extension never silently drops progress.
 */
/**
 * Best-effort subject for a todo task. rpiv-todo creates tasks with a `subject`
 * (see the `todo` `create` action); we also accept the common alternates so a
 * minor extension change never blanks the label. Falls back to "Untitled task".
 */
function taskLabel(task: unknown): string {
  if (task && typeof task === 'object') {
    const t = task as Record<string, unknown>
    for (const key of ['subject', 'title', 'content', 'text', 'name', 'task']) {
      const v = t[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return 'Untitled task'
}

export function parseTodoProgress(event: Record<string, unknown>): TodoProgress | undefined {
  const d = todoResultDetails(event)
  if (!d) return undefined

  if (Array.isArray(d.tasks)) {
    let total = 0
    let completed = 0
    let inProgress = 0
    const items: TodoItem[] = []
    for (const task of d.tasks) {
      const status = (task as { status?: unknown } | null)?.status
      if (status === 'deleted') continue
      total++
      if (status === 'completed') completed++
      else if (status === 'in_progress') inProgress++
      items.push({
        label: taskLabel(task),
        status:
          status === 'completed'
            ? 'completed'
            : status === 'in_progress'
              ? 'in_progress'
              : 'pending',
      })
    }
    return { completed, inProgress, total, items }
  }

  if (Array.isArray(d.todos)) {
    const completed = d.todos.filter((t) => (t as { done?: unknown } | null)?.done === true).length
    return { completed, inProgress: 0, total: d.todos.length }
  }

  return undefined
}

/** Tool-call signal read off a streamed Pi event, or undefined if not a tool call. */
function toolCallSignal(
  event: Record<string, unknown>,
): { name: string; isError: boolean } | undefined {
  // `tool_execution_end` is the canonical per-call stream event (statsFromEvents
  // counts the same one), so the guard reads it and nothing else — no double count.
  if (event.type !== 'tool_execution_end') return undefined
  const name = typeof event.toolName === 'string' ? event.toolName : ''
  return { name, isError: event.isError === true }
}

/** Tunable bounds for the {@link ProgressGuard}. */
export interface ProgressGuardLimits {
  /**
   * Abort once the agent has made this many NON-exploration tool calls without ever
   * using a file-editing tool (see `FILE_EDIT_TOOLS`). The signature of the credential
   * rabbit-hole that motivated this: probing the environment (`bash`/exec) endlessly
   * without implementing anything. Read-only exploration (`read`/`grep`/… — see
   * `EXPLORATION_TOOLS`) and planning (`todo`) do NOT count, so a large task that
   * legitimately reads/searches many files before its first edit is not killed for it.
   * Disabled when `expectsEdits` is false (e.g. the assess-only merger / Blueprinter,
   * which legitimately edit nothing). Note this bound only guards the run UNTIL its
   * first edit: once the agent has edited a file at all, it has demonstrably started
   * the work, so only `maxConsecutiveErrors` guards a later stall.
   */
  maxToolCallsWithoutEdit: number
  /**
   * Abort after this many consecutive failing tool calls — the agent is stuck
   * retrying an operation that keeps failing rather than making progress.
   */
  maxConsecutiveErrors: number
  /**
   * Abort after this many consecutive web-search/web-fetch calls with no other tool
   * call in between. Web tools are read-only exploration (they don't count toward the
   * no-edit bound), so without this a model could rabbit-hole on searches indefinitely
   * without ever tripping a guard. Any non-web tool call resets the streak. Optional:
   * defaults to {@link DEFAULT_PROGRESS_GUARD_LIMITS} when a caller builds limits
   * without it.
   */
  maxConsecutiveWebCalls?: number
}

// `satisfies` (not a type annotation) so each property keeps its concrete `number`
// type — `maxConsecutiveWebCalls` is optional on the interface (callers may omit it),
// but the defaults always define it, so consumers reading it off here get a `number`.
export const DEFAULT_PROGRESS_GUARD_LIMITS = {
  // Counts only non-exploration, non-planning calls (see EXPLORATION_TOOLS), so the
  // ceiling can be generous without risking a false kill on a read-heavy large task.
  maxToolCallsWithoutEdit: 40,
  maxConsecutiveErrors: 12,
  // A genuine research burst is a handful of searches; an uninterrupted run of this
  // many web calls (with no read/edit/bash between) is a search loop, not progress.
  maxConsecutiveWebCalls: 25,
} satisfies ProgressGuardLimits

// Tool names that mutate files, so a call to one clears the no-edit suspicion. Kept
// broad on purpose: different models/extensions name the same capability differently
// (`edit`/`write`, but also `apply_patch`/`patch`/`str_replace`/`multiedit`/`create`),
// and a false "no edits" reading would kill a run that IS making changes. Matched
// case-insensitively. NOTE: a file written purely via `bash` (e.g. a heredoc) is not
// recognised here — broaden or move to a working-tree signal if that becomes common.
const FILE_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'apply_patch',
  'patch',
  'str_replace',
  'multiedit',
  'create',
])

// Planning/bookkeeping tools that are neither file edits nor the environment-probing
// the no-edit bound targets — the todo list the agent maintains as it works. These do
// NOT count toward `maxToolCallsWithoutEdit`: a run that diligently updates a long
// todo list before its first edit (common on a large task) would otherwise be killed
// for "no edits" purely from planning calls. They still reset the consecutive-error
// streak (a successful call means the agent isn't wedged). Matched case-insensitively.
const PLANNING_TOOLS = new Set(['todo'])

// Read-only exploration tools: reading/searching the repo is legitimate work-up to an
// edit, NOT the environment-probing the no-edit bound targets, so they don't count
// toward `maxToolCallsWithoutEdit` (a large task may read/search dozens of files
// before its first edit). The bound thus counts only "action" calls — chiefly `bash`
// (the credential rabbit-hole's vector) — that have yet to produce an edit. Kept broad
// since models/extensions name the same capability differently. Matched case-insensitively.
const EXPLORATION_TOOLS = new Set([
  'read',
  'grep',
  'search',
  'glob',
  'ls',
  'list',
  'find',
  'tree',
  'cat',
  'view',
  'head',
  'tail',
  'stat',
  // rpiv-web-tools: querying/reading the web is read-only research up to an edit,
  // not the environment-probing the no-edit bound targets, so it doesn't count.
  'web_search',
  'web_fetch',
])

// The rpiv-web-tools calls, tracked separately so an unbounded run of them (with no
// other tool call between) can be caught as a search loop — see `maxConsecutiveWebCalls`.
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])

/** Read {@link ProgressGuardLimits} from the environment, falling back to the defaults. */
export function progressGuardLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProgressGuardLimits {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  }
  return {
    maxToolCallsWithoutEdit: num(
      env.JOB_MAX_TOOLCALLS_WITHOUT_EDIT,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxToolCallsWithoutEdit,
    ),
    maxConsecutiveErrors: num(
      env.JOB_MAX_CONSECUTIVE_TOOL_ERRORS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveErrors,
    ),
    maxConsecutiveWebCalls: num(
      env.JOB_MAX_CONSECUTIVE_WEB_CALLS,
      DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls,
    ),
  }
}

/**
 * Live anti-rabbithole guard: fed each streamed Pi event, it returns a diagnostic
 * reason the moment a run has plainly stopped making progress, so the harness can
 * kill Pi early instead of letting it burn the whole budget (and then surface a
 * useful failure instead of a generic "no file changes"). Pure and incremental so
 * it can be unit-tested over a fixed event sequence.
 */
export class ProgressGuard {
  private toolCalls = 0
  private edits = 0
  private consecutiveErrors = 0
  private consecutiveWebCalls = 0

  constructor(
    private readonly limits: ProgressGuardLimits,
    /** When false (assess-only runs like the merger), the no-edit bound is skipped. */
    private readonly expectsEdits: boolean = true,
  ) {}

  /** Feed one parsed Pi event; returns a diagnostic reason when the run should abort, else null. */
  observe(event: Record<string, unknown>): string | null {
    const tool = toolCallSignal(event)
    if (!tool) return null
    const name = tool.name.toLowerCase()
    // The error streak tracks ANY tool call (a planning call still proves the agent
    // isn't wedged in a failing-op loop), so it's updated before the planning skip.
    this.consecutiveErrors = tool.isError ? this.consecutiveErrors + 1 : 0
    if (this.consecutiveErrors >= this.limits.maxConsecutiveErrors) {
      return (
        `no progress: ${this.consecutiveErrors} consecutive failing tool calls — the agent is stuck ` +
        `retrying a failing operation rather than making progress. Aborting.`
      )
    }

    // Web search/fetch loop: web tools are read-only (they don't count toward the
    // no-edit bound), so guard them separately — an uninterrupted streak of them is a
    // research rabbit-hole. Any non-web tool call resets the streak.
    if (WEB_TOOLS.has(name)) {
      this.consecutiveWebCalls++
      const webCap =
        this.limits.maxConsecutiveWebCalls ?? DEFAULT_PROGRESS_GUARD_LIMITS.maxConsecutiveWebCalls
      if (this.consecutiveWebCalls >= webCap) {
        return (
          `no progress: ${this.consecutiveWebCalls} consecutive web search/fetch calls without ` +
          `any other action — the agent is stuck researching instead of doing the work. Aborting.`
        )
      }
    } else {
      this.consecutiveWebCalls = 0
    }

    // Planning and read-only exploration calls don't count toward the no-edit bound
    // (see PLANNING_TOOLS / EXPLORATION_TOOLS) — only "action" calls without an edit do.
    if (PLANNING_TOOLS.has(name) || EXPLORATION_TOOLS.has(name)) return null
    this.toolCalls++
    if (FILE_EDIT_TOOLS.has(name)) this.edits++

    if (
      this.expectsEdits &&
      this.edits === 0 &&
      this.toolCalls >= this.limits.maxToolCallsWithoutEdit
    ) {
      return (
        `no progress: ${this.toolCalls} tool calls and not one file edit — the agent is exploring or ` +
        `probing the environment without implementing anything. Aborting before it burns the whole run.`
      )
    }
    return null
  }
}

/**
 * Run Pi non-interactively against `cwd` and return its assistant summary. Uses
 * print + JSON mode (`-p --mode json`) with `--approve` so it runs unattended.
 *
 * The (untrusted) prompt is fed over stdin, never as an argv positional, so a
 * prompt beginning with `-`/`--` can't be mis-parsed as a Pi CLI flag (Pi has no
 * `--` end-of-options terminator, so a positional `-foo` errors as "Unknown
 * option"). Pi's print mode reads the prompt from piped stdin; we write it and
 * close the pipe so Pi gets an immediate EOF and proceeds (an open, never-closed
 * stdin pipe would make print mode block forever waiting for EOF).
 */
export function runPi(opts: {
  cwd: string
  model: string
  userPrompt: string
  sessionToken: string
  /** Aborting this kills Pi (the job's inactivity/max-duration watchdog). */
  signal?: AbortSignal
  /** Called on every chunk of Pi output, so the watchdog sees the agent is alive. */
  onActivity?: () => void
  /** Called with the latest subtask counts each time Pi updates its todo list. */
  onProgress?: (progress: TodoProgress) => void
  /**
   * Called once per completed tool call with a compact {@link ToolSpan}. Feeds the
   * run's observability trace (drained by the backend on its job poll); a no-op when
   * the container payload doesn't pass it, so production behaviour is unchanged.
   */
  onSpan?: (span: ToolSpan) => void
  /**
   * Called with every parsed Pi `--mode json` event, in stream order — the raw
   * observability seam over the run. Used by offline tooling (the smoketest
   * harness) to capture the full prompt/response/tool-call transcript for
   * analysis; the container payload doesn't pass it, so production behaviour is
   * unchanged. Throwing handlers are swallowed so a faulty observer can't break
   * the run.
   */
  onEvent?: (event: Record<string, unknown>) => void
  /** No-progress guard bounds; defaults to the env-configured limits. */
  guardLimits?: ProgressGuardLimits
  /** Whether this run is expected to edit files (false for assess-only runs like the merger). */
  expectsEdits?: boolean
  /**
   * Extra environment for Pi's child process, merged over `process.env` (but under the
   * proxy token). Used to hand the rpiv-web-tools extension its proxy-backed SearXNG
   * config (`SEARXNG_URL` / `SEARXNG_API_KEY`) without mutating the harness's own env.
   */
  extraEnv?: Record<string, string>
}): Promise<PiRunOutcome> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('pi aborted before start'))
      return
    }
    const child = spawn(
      'pi',
      ['-p', '--mode', 'json', '--model', `proxy/${opts.model}`, '--approve'],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.extraEnv, PI_PROXY_TOKEN: opts.sessionToken },
        // stdin is piped (not 'ignore') so the prompt is delivered out-of-band
        // rather than on argv — see the function doc for the injection rationale.
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    // Hand Pi the prompt over stdin, then close it so print mode sees EOF and
    // runs. Ignore stdin errors (e.g. EPIPE if Pi exits before reading): the
    // 'close'/'error' handlers below own the actual failure reporting.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.userPrompt)
    let stdout = ''
    let stderr = ''
    let aborted = false
    // Set when the no-progress guard kills Pi; carries the diagnostic the run
    // fails with (distinct from an external watchdog abort).
    let guardReason: string | undefined
    // Pi's json mode is strict LF-framed JSONL; buffer partial lines across
    // chunks so we only ever parse complete records for progress + the guard.
    let lineBuffer = ''
    const guard = new ProgressGuard(
      opts.guardLimits ?? progressGuardLimitsFromEnv(),
      opts.expectsEdits ?? true,
    )
    // Start boundary for the next tool span: each tool's slice runs from the previous
    // tool's end (or the run start) to its own `tool_execution_end`. Approximate but
    // contiguous — enough for the trace tree, and metadata-only.
    let toolBoundary = Date.now()

    // SIGTERM first, then SIGKILL if Pi ignores it. Shared by the watchdog abort
    // and the no-progress guard; the `close` handler turns it into a rejection.
    const killChild = (): void => killChildProcess(child)

    // Parse each complete JSONL record once, feeding both the todo-progress
    // emitter and the no-progress guard. A tripped guard kills Pi with a
    // diagnostic the run then fails on.
    const processLine = (line: string): void => {
      if (!line.startsWith('{')) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (opts.onEvent) {
        try {
          opts.onEvent(event)
        } catch {
          // A faulty observer must never break the run.
        }
      }
      if (opts.onProgress) {
        const progress = parseTodoProgress(event)
        if (progress) opts.onProgress(progress)
      }
      if (opts.onSpan) {
        const signal = toolCallSignal(event)
        if (signal && signal.name) {
          const endedAt = Date.now()
          try {
            opts.onSpan({
              tool: signal.name,
              startedAt: toolBoundary,
              endedAt,
              ok: !signal.isError,
            })
          } catch {
            // A faulty observer must never break the run.
          }
          toolBoundary = endedAt
        }
      }
      if (!guardReason && !aborted) {
        const reason = guard.observe(event)
        if (reason) {
          guardReason = reason
          killChild()
        }
      }
    }

    const consumeStdout = (text: string): void => {
      lineBuffer += text
      let nl = lineBuffer.indexOf('\n')
      while (nl !== -1) {
        const line = lineBuffer.slice(0, nl).trim()
        lineBuffer = lineBuffer.slice(nl + 1)
        nl = lineBuffer.indexOf('\n')
        processLine(line)
      }
    }

    // When the watchdog aborts, terminate Pi: the `close` handler then rejects
    // with the abort reason.
    const onAbort = (): void => {
      aborted = true
      killChild()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const onChunk = (chunk: Buffer, sink: 'out' | 'err'): void => {
      const text = chunk.toString()
      if (sink === 'out') {
        stdout += text
        consumeStdout(text)
      } else stderr += text
      // Any output means progress: reset the inactivity watchdog.
      opts.onActivity?.()
    }
    child.stdout.on('data', (chunk: Buffer) => onChunk(chunk, 'out'))
    child.stderr.on('data', (chunk: Buffer) => onChunk(chunk, 'err'))
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      if (guardReason) {
        const tail = redactSecrets(stderr.trim()).slice(-700)
        reject(new Error(tail ? `${guardReason} Agent stderr: ${tail}` : guardReason))
      } else if (aborted) {
        reject(
          new Error(
            opts.signal?.reason instanceof Error ? opts.signal.reason.message : 'pi aborted',
          ),
        )
      } else if (code === 0) {
        const tail = redactSecrets(stderr.trim()).slice(-1500)
        // Pi can exit 0 even when the agent run ended in a hard error (e.g. every
        // model call failed and its retries were exhausted): the process completed,
        // but the agent did not. Exit code alone then reads as success, and a run
        // that RESUMED a branch with prior commits would even open a PR off work this
        // pass never produced. Inspect the terminal transcript and fail loudly so the
        // step is marked failed instead of masking a total failure as green.
        const runError = terminalRunError(stdout)
        if (runError) {
          const scrubbed = redactSecrets(runError).slice(0, 1000)
          reject(new Error(tail ? `${scrubbed} Agent stderr: ${tail}` : scrubbed))
        } else {
          resolve({ ...summarizePiRun(stdout), ...(tail ? { stderrTail: tail } : {}) })
        }
      } else {
        reject(new Error(`pi exited with code ${code}: ${(stderr || stdout).slice(-500)}`))
      }
    })
  })
}

/** Parse Pi's LF-framed JSONL stdout into its event records, skipping noise. */
function parsePiEvents(stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      events.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      // Not a JSON event line; skip.
    }
  }
  return events
}

/**
 * The terminal-failure message when Pi's run ended in a hard error (the model was
 * unreachable / refused, and Pi exhausted its auto-retries), else undefined. Only
 * the FINAL outcome counts: a mid-run hiccup the agent recovered from leaves a clean
 * terminal `agent_end`, so it returns undefined. Scans from the end and decides on
 * the first terminal signal it meets — the trailing `auto_retry_end` (its `success`
 * flag) or the last `agent_end` (its `stopReason`). Pure so it is unit-testable over
 * a fixed event sequence.
 */
export function terminalRunError(stdout: string): string | undefined {
  const events = parsePiEvents(stdout)
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'auto_retry_end') {
      if (e.success === false) {
        return typeof e.finalError === 'string'
          ? e.finalError
          : 'the agent failed after exhausting its retries'
      }
      return undefined
    }
    if (e.type === 'agent_end') {
      return e.stopReason === 'error' && typeof e.errorMessage === 'string'
        ? e.errorMessage
        : undefined
    }
  }
  return undefined
}

/**
 * Pi's assistant summary plus {@link PiRunStats}, derived from one pass over its
 * output — the canonical close-of-run signal the harness uses both to report the
 * answer and to detect a no-op run (the agent never acted).
 */
export function summarizePiRun(stdout: string): PiRunOutcome {
  const events = parsePiEvents(stdout)
  return {
    summary: summaryFromEvents(events, stdout),
    stats: statsFromEvents(events),
    diagnostics: diagnosticsFromEvents(events),
  }
}

/**
 * Output-quality signals over the canonical `agent_end` transcript: whether any
 * completion hit the output ceiling (its content was cut off), whether the FINAL
 * completion did, and whether that final turn carried no text at all. Pure so it is
 * unit-testable over a fixed event sequence. Defaults to all-false when there is no
 * terminal transcript (a no-op run is already caught by {@link agentNeverActed}).
 *
 * `cap` is the per-completion ceiling Pi requested ({@link PI_MAX_OUTPUT_TOKENS});
 * truncation is detected by an assistant message whose `usage.output` reached it,
 * which is reliable even when the model reports a non-`length` stop reason (Workers
 * AI labelled a cut-off tool call `tool_calls`, not `length`).
 */
export function diagnosticsFromEvents(
  events: Record<string, unknown>[],
  cap: number = PI_MAX_OUTPUT_TOKENS,
): RunDiagnostics {
  let messages: unknown[] | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'agent_end' && Array.isArray(e.messages)) {
      messages = e.messages as unknown[]
      break
    }
  }
  if (!messages) return { truncated: false, finalTruncated: false, finalAnswerEmpty: false }
  const assistants = messages.filter(
    (m): m is Record<string, unknown> => isObject(m) && m.role === 'assistant',
  )
  const truncated = assistants.some((m) => assistantOutputTokens(m) >= cap)
  const last = assistants.at(-1)
  return {
    truncated,
    finalTruncated: last ? assistantOutputTokens(last) >= cap : false,
    finalAnswerEmpty: last ? messageText(last) === '' : false,
  }
}

/** `usage.output` (completion tokens) reported on a Pi assistant message, or 0. */
function assistantOutputTokens(message: Record<string, unknown>): number {
  const usage = message.usage
  if (!isObject(usage)) return 0
  const output = usage.output
  return typeof output === 'number' ? output : 0
}

/** {@link RunDiagnostics} over Pi's raw `--mode json` stdout (see {@link diagnosticsFromEvents}). */
export function runDiagnostics(stdout: string, cap: number = PI_MAX_OUTPUT_TOKENS): RunDiagnostics {
  return diagnosticsFromEvents(parsePiEvents(stdout), cap)
}

/**
 * Count what the agent actually did. Prefers the canonical `agent_end`
 * transcript (assistant `toolCall` parts + text); falls back to the streamed
 * `tool_execution_end` / `message_end` events when no terminal transcript was
 * emitted, so a no-op is never mistaken for a real run because of a schema tweak.
 */
function statsFromEvents(events: Record<string, unknown>[]): PiRunStats {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'agent_end' && Array.isArray(e.messages)) {
      return statsFromMessages(e.messages as unknown[])
    }
  }
  let toolCalls = 0
  let toolResults = 0
  let assistantChars = 0
  for (const e of events) {
    if (e.type === 'tool_execution_end') {
      toolCalls++
    } else if (e.type === 'message_end' && isObject(e.message)) {
      const m = e.message
      if (m.role === 'assistant') assistantChars += messageText(m).length
      else if (m.role === 'toolResult') toolResults++
    }
  }
  // The same call can surface as both a `tool_execution_end` and a toolResult
  // `message_end`; prefer the former and only fall back to toolResult counts.
  return { toolCalls: toolCalls || toolResults, assistantChars }
}

/** {@link PiRunStats} from a transcript: assistant `toolCall` parts + text length. */
function statsFromMessages(messages: unknown[]): PiRunStats {
  let toolCalls = 0
  let assistantChars = 0
  for (const m of messages) {
    if (!isObject(m) || m.role !== 'assistant') continue
    const content = m.content
    if (typeof content === 'string') {
      assistantChars += content.trim().length
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!isObject(part)) continue
        if (part.type === 'toolCall') toolCalls++
        else if (typeof part.text === 'string') assistantChars += part.text.length
      }
    }
  }
  return { toolCalls, assistantChars }
}

/**
 * Extract the assistant's final summary from Pi's JSON-lines output. Pi emits a
 * terminal `agent_end` event whose `messages` is the full transcript, so the
 * last assistant message there is the canonical answer. Falls back to scanning
 * `message_end` events, then to a raw tail, so a schema tweak never loses output.
 */
export function parsePiOutput(stdout: string): string {
  return summaryFromEvents(parsePiEvents(stdout), stdout)
}

/** Shared summary extraction over already-parsed events (see {@link parsePiOutput}). */
function summaryFromEvents(events: Record<string, unknown>[], stdout: string): string {
  // Preferred: the final transcript from the last agent_end event.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'agent_end' && Array.isArray(e.messages)) {
      const text = lastAssistantText(e.messages as unknown[])
      if (text) return text
    }
  }

  // Fallback: assistant text accumulated from message_end events.
  const parts: string[] = []
  for (const e of events) {
    if (
      e.type === 'message_end' &&
      typeof e.message === 'object' &&
      e.message !== null &&
      (e.message as { role?: unknown }).role === 'assistant'
    ) {
      const text = messageText(e.message)
      if (text) parts.push(text)
    }
  }
  const joined = parts.join('\n').trim()
  if (joined) return joined

  // Nothing structured matched — return a trimmed tail of the raw output.
  return stdout.trim().slice(-2000)
}

/** The text of the last assistant message in a transcript, or '' if none. */
function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (typeof m === 'object' && m !== null && (m as { role?: unknown }).role === 'assistant') {
      const text = messageText(m)
      if (text) return text
    }
  }
  return ''
}

/** Join the text parts of a Pi message whose content is a string or parts array. */
function messageText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('')
      .trim()
  }
  return ''
}
