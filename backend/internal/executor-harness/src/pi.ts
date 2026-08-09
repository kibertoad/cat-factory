import { spawn } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { killChildProcess, spawnDetached } from './process.js'
import { pathExists } from './fs-utils.js'
import { redactSecrets, secretsToRedact } from './redact.js'
import { HarnessFailure } from './failure.js'
import { log } from './logger.js'
import type { EffortReport } from './effort.js'
import {
  ProgressGuard,
  progressGuardLimitsFromEnv,
  toolCallSignal,
  type ProgressGuardLimits,
} from './progress-guard.js'
import {
  ToolCallTracker,
  readToolCallId,
  toolCallResult,
  toolCallStart,
} from './tool-trajectory.js'
import { BoundedTail, JsonlLineReader } from './jsonl-stream.js'
import {
  PI_MAX_OUTPUT_TOKENS,
  PiRunReducer,
  isObject,
  type PiRunStats,
  type RunDiagnostics,
} from './pi-reduction.js'
import { NO_TOOL_WINDOW, type ToolProgressWindow } from './tool-silence.js'

// Drives the Pi coding-agent CLI. Pi is pointed at the Worker's OpenAI-compatible
// proxy via a custom provider in ~/.pi/agent/models.json, authenticated with the
// per-job session token (interpolated from $PI_PROXY_TOKEN) — so no provider key
// ever lives in the image or in Pi's config on disk.

/**
 * How much of Pi's raw stdout/stderr the run holds for diagnostics. Every consumer takes a tail
 * of it (2 KB for the last-resort summary, 1.5 KB for a stderr quote, 500 B for a crash detail),
 * so this is generous headroom over the largest of them rather than a number anything depends
 * on. What it replaces is retaining the WHOLE of a chatty run's output to slice 2 KB off the end
 * (stuck-run audit F6).
 */
const OUTPUT_TAIL_CHARS = 64 * 1024

/**
 * Longest phase label the backend keeps. Mirrors kernel's `MAX_PHASE_CHARS`; see
 * {@link normalizeProxyPhase} for why this is a copy rather than an import.
 */
const MAX_PHASE_CHARS = 32

/**
 * Normalise a phase label to what the backend will actually store: trimmed, lowercased,
 * `[a-z0-9-]` only, bounded. `''` when the label is not a phase at all.
 *
 * A deliberate COPY of kernel's `normalizeCallPhase` — the container image is built from `src/`
 * plus typescript alone, so the harness can carry no runtime dependency on a workspace package
 * (the same constraint that forced `src/host-markdown.ts`). A copy that can drift is worse than
 * no copy: if the harness rejected a label the backend would have accepted, the call would take
 * the plain path and land unattributed, and if it accepted one the backend rejects it would
 * spend a request on a segment destined for `''`. `test/llm-phase.conformity.test.ts` pins the
 * two to identical verdicts over a corpus, so the alphabet can only be changed in both.
 */
export function normalizeProxyPhase(phase: string | undefined): string {
  if (typeof phase !== 'string') return ''
  const trimmed = phase.trim().toLowerCase()
  if (!trimmed || trimmed.length > MAX_PHASE_CHARS) return ''
  return /^[a-z0-9-]+$/.test(trimmed) ? trimmed : ''
}

/**
 * Point Pi's provider at the phase-tagged completions path for the pass about to run, so the
 * backend can stamp WHICH slice of the run spent each call (the agent's own loop vs a pre-PR
 * validation repair round vs a reproduction-proof repair round) — see
 * `docs/initiatives/token-burn-instrumentation.md`. The harness drives those loops, so it is
 * the only component that knows; reconstructing the boundary downstream from wall-clock
 * timestamps is exactly the brittle inference this avoids.
 *
 * A URL segment because the harness does not make these requests: Pi does, from a config whose
 * only per-run knobs are the base URL and the token — there is no per-request header to set.
 *
 * `supported` is the BACKEND's declaration that it serves the phase-tagged route, carried on the
 * job body exactly as `webSearch` carries "point the search tool at my `/web-search`". Without it
 * this function would encode a routing shape the receiving backend may not have: a runner pool
 * pins its OWN harness image (`RunnerPoolManifest`), and `LOCAL_HARNESS_IMAGE` overrides the
 * recommended pin outright, so "the image and the backend are a matched set" holds for the
 * Cloudflare deployment and nowhere else. An image ahead of its backend would 404 EVERY model
 * call — a dead run, not degraded telemetry. Absent/false ⇒ the plain path, and the calls land
 * in the backend's unattributed slice.
 *
 * Pure so the join is unit-testable without spawning anything.
 */
export function phasedProxyBaseUrl(
  proxyBaseUrl: string,
  phase: string | undefined,
  supported: boolean | undefined,
): string {
  if (!supported) return proxyBaseUrl
  // A label the backend would discard would be sent only to be thrown away, so send the plain
  // path instead — the call is then honestly unattributed rather than attributed to nothing.
  const normalized = normalizeProxyPhase(phase)
  if (!normalized) return proxyBaseUrl
  return `${proxyBaseUrl.replace(/\/+$/, '')}/phase/${normalized}`
}

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

// NOTE: the spec-reading guidance is NOT appended here. It is contributed once, backend-side, by
// the `spec-aware` trait (`SPEC_AWARE_GUIDANCE` in @cat-factory/agents), which lands in the
// composed system prompt for every spec-aware kind on BOTH harness paths. This harness used to
// append a near-duplicate block, so a spec-aware Pi run carried the guidance twice; the claude-code
// path never appended it. Sourcing it solely from the trait dedupes the Pi prompt and makes the two
// paths consistent. (A non-spec-aware kind is deliberately not told to read the spec.)

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
    multiRepo?: boolean
    /**
     * Whether the checkout actually ships a `blueprints/` folder. The blueprint orientation
     * note is only appended when it does — otherwise it is ~10 lines of dead guidance (re-sent
     * every turn) pointing at files that don't exist. Absent/false ⇒ the note is omitted.
     */
    hasBlueprints?: boolean
    /**
     * The reference-design block composed by `referenceScreenshotGuidance`: which files the run
     * was handed and which it could not fetch. Composed by the caller (it is the only side that
     * knows what actually landed on disk) and appended verbatim. Absent/'' ⇒ nothing is said,
     * which is the normal case: only a capturing kind is sent references at all.
     */
    referenceGuidance?: string
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
  // resolved a monorepo service directory; the agent's cwd already points at it. A
  // MULTI-REPO run runs at the workspace root (cwd spans sibling checkouts), so the
  // monorepo note is suppressed there — the multi-repo mechanics note replaces it.
  const monorepo =
    opts.serviceDirectory && !opts.multiRepo ? monorepoGuidance(opts.serviceDirectory) : ''
  // Multi-repo mechanics note (service-connections phase 3): the concrete repo→role mapping
  // is in the backend-composed system prompt above; this explains the shared MECHANICS (cwd
  // is the workspace root, repos are sibling checkouts, one PR per dirty repo).
  const multiRepo = opts.multiRepo ? MULTI_REPO_GUIDANCE : ''
  // Point the agent at any linked context the backend materialised into the checkout
  // (requirements / RFCs / PRDs / tracker issues) so it reads them on demand.
  const context = contextGuidance(opts.contextFiles ?? [])
  // Only orient the agent to `blueprints/` when the checkout actually has them — otherwise the
  // note is dead weight re-sent on every turn. The spec-reading guidance is NOT appended here
  // (see the note above `writeAgentsContext`): it comes solely from the backend `spec-aware`
  // trait, so a spec-aware run no longer carries it twice.
  const blueprint = opts.hasBlueprints ? BLUEPRINT_GUIDANCE : ''
  // The reference designs the harness downloaded for a capturing kind, listed with their view
  // names (and the ones that could not be fetched). Last, beside the linked-context list it is the
  // sibling of: both point the agent at files already on disk.
  const references = opts.referenceGuidance ?? ''
  await writeFile(
    join(dir, 'AGENTS.md'),
    `${systemPrompt}${blueprint}${TODO_GUIDANCE}${monorepo}${multiRepo}${webTools}${context}${references}`,
    'utf8',
  )
}

/** The MULTI-REPO mechanics note appended to AGENTS.md when a run spans sibling checkouts. */
const MULTI_REPO_GUIDANCE = `

## Multi-repo workspace (work across sibling checkouts)

This task spans MORE THAN ONE repository. Your working directory is the WORKSPACE ROOT, and
each involved repository is checked out as a sibling directory directly under it. The workspace
root itself is NOT a git repository — run git INSIDE each repository's directory. The system
prompt above lists which repository is which and each one's role. Make the cross-service
change coherently across every repository the task requires — a provider's API and its
consumer's call site belong in the SAME piece of work. Run each repository's own build/test
commands inside that repository's directory.

Commit your own work inside each repository you change (\`cd\` into it, stage the files that
belong — INCLUDING any new files you added — and commit). The platform will NOT add untracked
files for you, so anything you leave uncommitted and untracked is lost. Each repository you
change is opened as a SEPARATE pull request; leave a repository untouched if the task does not
require changing it.`

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
  await excludeContextDir(cwd)
}

/**
 * Add the LOCAL git exclude entry for {@link CONTEXT_DIR}, so nothing the harness materialises
 * there can be committed into the agent's PR by a `git add -A`.
 *
 * The exclude pattern has no leading slash, so it matches `.cat-context/` at any depth, covering
 * the monorepo case where cwd is a service subdirectory below the repo root. Best-effort: a
 * scaffold-from-scratch checkout has no `.git` yet, and the files then simply stay untracked.
 *
 * One helper rather than a copy per materialiser: every writer into that directory owes the same
 * exclude, and a new one that forgot it would leak the platform's own files into a customer's
 * repository with nothing failing.
 */
export async function excludeContextDir(cwd: string): Promise<void> {
  const gitRoot = await findGitRoot(cwd)
  if (!gitRoot) return
  try {
    await appendFile(join(gitRoot, '.git', 'info', 'exclude'), `\n${CONTEXT_DIR}/\n`, 'utf8')
  } catch {
    // No writable .git/info; the files simply stay untracked (still not auto-added on most flows).
  }
}

/** Subdirectory of {@link CONTEXT_DIR} where a skill's resources are materialised, per skill. */
export const SKILL_CONTEXT_SUBDIR = 'skill'

/**
 * Materialise the run's skills' RESOURCE files under `.cat-context/skill/<name>/` in the checkout
 * — the path for every run that does NOT get a native install: Pi, codex, and ambient claude-code
 * (no isolated `CLAUDE_CONFIG_DIR` to install into). Their agents read the checkout, and the
 * skills' instructions are folded into their prompt by the backend (`renderSkillsForHarness`,
 * which keys off ambient auth as well as the harness).
 *
 * Each skill gets its OWN subdirectory: several skills can apply to one run (a step's pick plus
 * the kind's declared playbooks), and a flat directory would let two skills' `templates/report.md`
 * overwrite each other — silently handing the agent the wrong template. The names were sanitized
 * to a single safe path segment at the job boundary, as were the resource sub-paths (no
 * traversal), so nested dirs are created as needed. Kept out of the agent's commits via the same
 * `.cat-context/` git exclude entry. Skills with no resource bodies are a no-op.
 */
export async function materializeSkillResources(
  cwd: string,
  skills: { name: string; resources: { relPath: string; content: string }[] }[],
): Promise<void> {
  const withResources = skills.filter((s) => s.resources.length)
  if (!withResources.length) return
  for (const skill of withResources) {
    const dir = join(cwd, CONTEXT_DIR, SKILL_CONTEXT_SUBDIR, skill.name)
    await mkdir(dir, { recursive: true })
    for (const r of skill.resources) {
      const dest = join(dir, r.relPath)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, r.content, 'utf8')
    }
  }
  await excludeContextDir(cwd)
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
 * One tool invocation in an agent's loop, captured for the run's TRAJECTORY: the ordered
 * account of what the agent did, drained by the backend on its existing job poll and
 * both persisted and emitted as a child span under the run trace.
 *
 * It carries the call's arguments and result (scrubbed and capped at capture — see
 * `tool-trajectory.ts`), because the question asked of a finished run is which command
 * ran against what, not how long a tool named `bash` took. Whether those bodies are
 * RETAINED is the backend's decision, taken against the deployment switch and the
 * workspace's opt-out; the harness's job is to capture them bounded and scrubbed.
 */
export interface ToolSpan {
  tool: string
  /**
   * The call's 0-based ordinal within this job. Two calls routinely land in the same
   * millisecond, so this is the only thing that orders the trajectory — and it is what
   * makes the backend's stored row id deterministic, so a replayed poll re-records
   * instead of duplicating.
   */
  seq: number
  /** Epoch ms the tool call started (the previous call's end when no start was seen). */
  startedAt: number
  /** Epoch ms the tool call ended (when its `tool_execution_end` event arrived). */
  endedAt: number
  ok: boolean
  /** Whether the bodies below were captured at all — always `'stored'` from this harness. */
  bodies: 'stored' | 'withheld'
  /** The call's arguments, serialised, scrubbed and capped. `''` when it took none. */
  args: string
  /** What the tool returned, scrubbed and capped. `''` when it returned nothing. */
  result: string
  /** Characters the cap dropped from {@link args} / {@link result}; 0 when nothing was cut. */
  argsDropped: number
  resultDropped: number
}

/**
 * One model call captured from a subscription harness's CLI event stream, shaped so
 * the backend can record it into the same `llm_call_metrics` telemetry the LLM proxy
 * writes for the Pi harness. The subscription harnesses (Claude Code / Codex) talk
 * DIRECT to the vendor and never touch the proxy, so this is the only place their
 * per-call bodies are observable. Claude Code's `stream-json --verbose` is a near-
 * verbatim Anthropic Messages stream, so its calls carry full request/response
 * bodies; Codex's `exec --json` only surfaces flat assistant text + per-turn tokens,
 * so its rows are honestly thinner (no request transcript, no tool/command bodies).
 */
export interface HarnessCallMetric {
  /** The vendor model that served this call (from the CLI event), when reported. */
  model?: string
  /**
   * The full request as an OpenAI-style chat array (`[{role, content}, …]`),
   * JSON-stringified — the growing history as of this call. Matches the proxy's
   * `promptText` shape so the telemetry chain delta-compresses + renders identically.
   */
  promptText: string
  /** Number of messages encoded in {@link promptText} (the telemetry chain messageCount). */
  messageCount: number
  /** The assistant's response text, as a plain string (`''` for a tool-only turn). */
  responseText: string
  /** The reasoning/thinking trace, as a plain string (`''` when none). */
  reasoningText: string
  /**
   * FRESH (uncached) input tokens: exclusive of BOTH cache classes below, so the three
   * are orthogonal and additive. Every producer normalises to this — reading the already
   * exclusive field where the vendor reports the classes apart (Anthropic), subtracting
   * the cached share where the vendor reports an inclusive prompt count (Codex/OpenAI).
   */
  inputTokens: number
  /** Input tokens served from the vendor's prompt cache (~0.1× base input). */
  cacheReadTokens: number
  /**
   * Input tokens written INTO the vendor's cache (1.25–2× base input — dearer than fresh),
   * kept apart from the reads so a loop that keeps re-writing the prefix is distinguishable
   * from one riding a warm cache. 0 where the CLI reports no separate write class.
   */
  cacheWriteTokens: number
  outputTokens: number
  /** The provider finish/stop reason when the CLI reports one (else null). */
  finishReason: string | null
  /**
   * This call's position in the JOB's telemetry sequence, stamped by the job registry the
   * moment the call is emitted (see `RunOptions.onCallMetric`). It is what makes a call's
   * recorded row id stable across the two channels that carry it: the live drain (per poll,
   * so a run's telemetry is inspectable WHILE it runs) and the terminal result (the complete
   * list, so a transport that doesn't drain still records everything). Both channels hold the
   * SAME metric objects, so both mint the same `<jobId>-hc-<seq>` row id and the backend's
   * second write of an already-recorded call is a no-op instead of a duplicate row.
   *
   * Absent only when a producer built a metric without emitting it live; the recorder then
   * falls back to the array index, which is what it always used before streaming existed.
   */
  seq?: number
  /**
   * The run PHASE that spent this call (`agent` / `validation-repair` / `reproduction-repair` /
   * …), stamped by the job registry from the same marker the handlers set as they enter each
   * phase — so the phase axis on `llm_call_metrics` comes from the component that owns the
   * boundary rather than from a downstream guess
   * (`docs/initiatives/token-burn-instrumentation.md`).
   *
   * Stamped on the SAME object as {@link seq}, so the live drain and the terminal result can
   * never disagree about which phase billed a call.
   */
  phase?: string
}

/**
 * Publish one captured model call: append it to the run's list (which becomes the terminal
 * result's `callMetrics`) AND hand the SAME object to the live stream, where the job registry
 * stamps its {@link HarnessCallMetric.seq} and buffers it for the next poll to drain.
 *
 * Every producer goes through here rather than a bare `calls.push`, so the two channels can't
 * drift: a call that reaches the terminal list but never the live stream would be invisible
 * until the job ends, and one that reaches only the live stream would go unrecorded if the
 * poll response were lost.
 *
 * A published call must be FINAL. The backend records it the moment the drain reaches it and
 * IGNORES the terminal repeat (first write wins, so its stored prompt delta stays valid against
 * the chain tip it was written against), which means a field mutated after publishing never
 * reaches the store. A producer whose calls can still change (the cumulative-usage fallback,
 * whose totals arrive with the CLI's terminal `result` event) publishes through
 * {@link createCallMetricPublisher} instead, which withholds exactly those.
 */
export function publishCallMetric(
  calls: HarnessCallMetric[],
  call: HarnessCallMetric,
  onCallMetric?: (call: HarnessCallMetric) => void,
): void {
  calls.push(call)
  onCallMetric?.(call)
}

/** Appends captured calls to a run's list, streaming each one as soon as it is final. */
export interface CallMetricPublisher {
  /** Append a captured call, streaming it now unless its tokens can still be rewritten. */
  publish(call: HarnessCallMetric): void
  /** Stream whatever is still withheld. Call once the run's totals are attributed. */
  flush(): void
}

/**
 * A {@link publishCallMetric} wrapper for a producer whose per-call tokens may be filled in at
 * the END of the run: a CLI that reports only a cumulative total leaves every turn at zero, and
 * `attributeCumulativeUsage` pins the total onto the last call once the terminal `result` event
 * arrives.
 *
 * Since a published call must be final (the backend stores it on the drain and ignores the
 * terminal repeat), a call the CLI did NOT cost is appended to the list but WITHHELD from the
 * live stream — otherwise it records as a zero-token row and the attributed numbers never land.
 * The withholding window closes the moment any call IS costed: attribution can no longer fire, so
 * everything held is final and released at once, in capture order, and every later call streams
 * immediately whatever its tokens. {@link flush} covers the run that was never costed at all.
 */
export function createCallMetricPublisher(
  calls: HarnessCallMetric[],
  onCallMetric?: (call: HarnessCallMetric) => void,
): CallMetricPublisher {
  const withheld: HarnessCallMetric[] = []
  let anyCosted = false
  const flush = (): void => {
    for (const call of withheld) onCallMetric?.(call)
    withheld.length = 0
  }
  return {
    publish(call) {
      const costed = call.inputTokens > 0 || call.outputTokens > 0
      if (!costed && !anyCosted) {
        publishCallMetric(calls, call)
        withheld.push(call)
        return
      }
      if (costed) anyCosted = true
      // Released BEFORE this call so the live sequence stays in capture order.
      flush()
      publishCallMetric(calls, call, onCallMetric)
    },
    flush,
  }
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
  /**
   * Per-model-call telemetry lifted from a subscription harness's CLI event stream
   * (Claude Code / Codex), which the backend records into `llm_call_metrics` — the
   * proxy-bypassing analogue of the per-call rows the LLM proxy writes for Pi. Absent
   * for the proxy-metered Pi harness (the proxy is its metering point). See
   * {@link HarnessCallMetric}.
   */
  callMetrics?: HarnessCallMetric[]
  /** Output-quality signals (truncation / empty final answer); see {@link RunDiagnostics}. */
  diagnostics?: RunDiagnostics
  /**
   * The agent's effort self-assessment, lifted from its sentinel file after the run (how hard the
   * work was, what reduced its effectiveness, the key obstacles). Absent when the agent wrote none.
   * See {@link EffortReport}.
   */
  effortReport?: EffortReport
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
// The no-progress guard (its limits, tool vocabulary and the `ProgressGuard` itself) lives in
// `progress-guard.ts` — it is shared with the claude-code runner, so it is no longer Pi's.

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
   * Opens this stream's tool-silence window (see `RunOptions.beginToolWindow`), closed when Pi
   * exits. Pi reports every completed tool call, so the window it opens is one this run can
   * always beat; a caller that passes nothing leaves the watchdog silent for the run.
   */
  beginToolWindow?: () => ToolProgressWindow
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
        // Own process group (POSIX) so killChildProcess reaps Pi's grandchildren too.
        detached: spawnDetached,
      },
    )
    // Hand Pi the prompt over stdin, then close it so print mode sees EOF and
    // runs. Ignore stdin errors (e.g. EPIPE if Pi exits before reading): the
    // 'close'/'error' handlers below own the actual failure reporting.
    child.stdin.on('error', () => {})
    child.stdin.end(opts.userPrompt)
    // The close-of-run answers (summary, stats, diagnostics, terminal error), FOLDED as the
    // records stream instead of re-parsing the whole of stdout two more times at close: those
    // passes were O(entire output) on the event loop the watchdog timers and the poll endpoints
    // share, at exactly the moment the job is settling (stuck-run audit F6). Folding rather than
    // retaining the parsed records is the other half of that bound — it is what makes this not a
    // second copy of the run, which an unbounded array of parsed objects would have been.
    const reduction = new PiRunReducer()
    // This stream's tool-silence window: Pi reports every completed tool call, so each one below
    // beats it. Closed on BOTH terminal paths (`error` and `close`) — a window outliving the
    // process it watches would expire against a run that is already over.
    const toolWindow = opts.beginToolWindow?.() ?? NO_TOOL_WINDOW
    // Raw output kept ONLY to quote on a failure, so a bounded tail is the whole requirement —
    // the longest slice anyone takes below is 2 KB.
    const stdout = new BoundedTail(OUTPUT_TAIL_CHARS)
    const stderr = new BoundedTail(OUTPUT_TAIL_CHARS)
    let aborted = false
    // Set when the no-progress guard kills Pi; carries the diagnostic the run
    // fails with (distinct from an external watchdog abort).
    let guardReason: string | undefined
    // Counters for silent losses, warned ONCE at close (not per-line, to avoid log
    // spam): `{`-leading lines that failed to JSON.parse, and observer-callback throws.
    let malformedLines = 0
    let observerErrors = 0
    const guard = new ProgressGuard(
      opts.guardLimits ?? progressGuardLimitsFromEnv(),
      opts.expectsEdits ?? true,
    )
    // Pairs each tool call's start with its result, numbers the pairs and captures the two
    // bodies (scrubbed + capped). A call whose start Pi never emitted still gets an entry,
    // timed from the previous call's end — see `ToolCallTracker`.
    //
    // The known-secret list is DERIVED from the token this function itself hands the child
    // (`PI_PROXY_TOKEN` / `SEARXNG_API_KEY`) rather than taken as a parameter: the bodies
    // travel to a store and to external trace sinks, and a caller that forgets to pass the
    // list produces bodies scrubbed of credential SHAPES only, with no signal that the
    // narrower rule ever ran. Deriving it here means the one place that knows the child's
    // credentials is the place that scrubs them.
    const tools = new ToolCallTracker(secretsToRedact(opts.sessionToken))

    // SIGTERM first, then SIGKILL if Pi ignores it. Shared by the watchdog abort
    // and the no-progress guard; the `close` handler turns it into a rejection.
    const killChild = (): void => killChildProcess(child)

    // Parse each complete JSONL record once, retaining it for the close-of-run reductions and
    // feeding the todo-progress emitter and the no-progress guard. A tripped guard kills Pi
    // with a diagnostic the run then fails on.
    // `final` marks the at-close flush of a final unterminated line: the process has already
    // exited, so feeding that record to the no-progress guard could trip it and turn a clean
    // (code 0) exit into a spurious "no progress" rejection. The flush still recovers the
    // record's progress/span signal; only the kill decision is skipped.
    const processLine = (line: string, final: boolean): void => {
      if (!line.startsWith('{')) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        // A `{`-leading line that doesn't parse is a corrupted/truncated record we drop
        // (progress/spans for it are lost). Count it; warned once at close.
        malformedLines++
        return
      }
      reduction.observe(event)
      if (opts.onEvent) {
        try {
          opts.onEvent(event)
        } catch {
          // A faulty observer must never break the run.
          observerErrors++
        }
      }
      if (opts.onProgress) {
        const progress = parseTodoProgress(event)
        if (progress) opts.onProgress(progress)
      }
      // A completed tool call is the progress the tool-silence watchdog measures. Detected
      // OUTSIDE the span branch below: the trajectory is an observability opt-in, and a watchdog
      // that only ran when someone wanted spans would be armed against a stream it could not see.
      const signal = toolCallSignal(event)
      if (signal?.name) toolWindow.toolCompleted()
      if (opts.onSpan) {
        const start = toolCallStart(event)
        if (start) tools.started(start.id, start.name, start.args)
        if (signal?.name) {
          const call = tools.finished(
            readToolCallId(event),
            signal.name,
            toolCallResult(event),
            signal.isError,
          )
          try {
            opts.onSpan({ ...call, bodies: 'stored' })
          } catch {
            // A faulty observer must never break the run.
            observerErrors++
          }
        }
      }
      if (!final && !guardReason && !aborted) {
        const reason = guard.observe(event)
        if (reason) {
          guardReason = reason
          killChild()
        }
      }
    }

    // Pi's json mode is strict LF-framed JSONL; the reader buffers partial records across
    // chunks (bounded — see `JsonlLineReader`) so we only ever parse complete ones.
    const reader = new JsonlLineReader(processLine)

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
        stdout.push(text)
        reader.push(text)
      } else stderr.push(text)
      // Any output means progress: reset the inactivity watchdog.
      opts.onActivity?.()
    }
    child.stdout.on('data', (chunk: Buffer) => onChunk(chunk, 'out'))
    child.stderr.on('data', (chunk: Buffer) => onChunk(chunk, 'err'))
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', onAbort)
      toolWindow.close()
      reject(error)
    })
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort)
      toolWindow.close()
      // Flush a final record that arrived without a trailing newline: Pi usually LF-frames
      // every line, but a clean exit can leave the last event (often `agent_end`) unterminated
      // in the buffer, so without this its progress/span/guard signal would be silently lost.
      reader.flush()
      // Surface any silent stream losses ONCE (counts, not per-line), so a corrupted JSONL
      // stream, an oversized record the reader refused to buffer, or a throwing observer is
      // diagnosable rather than invisible.
      if (malformedLines > 0 || observerErrors > 0 || reader.droppedLines > 0) {
        log.warn('pi: skipped malformed/oversized JSONL lines or observer errors', {
          malformedLines,
          oversizedLines: reader.droppedLines,
          observerErrors,
        })
      }
      const settled = settlePiRun({
        code,
        reduction,
        droppedLines: reader.droppedLines,
        aborted,
        stdoutTail: stdout.toString(),
        stderrTail: stderr.toString(),
        ...(guardReason ? { guardReason } : {}),
        ...(opts.signal?.reason instanceof Error
          ? { abortReason: opts.signal.reason.message }
          : {}),
      })
      if (settled.ok) resolve(settled.outcome)
      else reject(settled.error)
    })
  })
}

/**
 * Turn an EXITED Pi process into the run's outcome or its failure. Split out of {@link runPi} for
 * the per-function budget, and pure so the dispositions can be reasoned about (and tested) without
 * spawning anything: everything it needs is already reduced by the time the process closes.
 *
 * The four dispositions, in the order they win: the no-progress guard's own kill, the external
 * watchdog's abort, a crash, and a clean exit — which is where the run is CERTIFIED, below.
 */
function settlePiRun(args: {
  code: number | null
  reduction: PiRunReducer
  /** Records the framing reader refused to buffer; see the certification note below. */
  droppedLines: number
  aborted: boolean
  guardReason?: string
  abortReason?: string
  stdoutTail: string
  stderrTail: string
}): { ok: true; outcome: PiRunOutcome } | { ok: false; error: Error } {
  const { code, reduction, droppedLines, aborted, guardReason, stdoutTail, stderrTail } = args
  const fail = (error: Error): { ok: false; error: Error } => ({ ok: false, error })
  if (guardReason) {
    const guardTail = redactSecrets(stderrTail.trim()).slice(-700)
    return fail(new Error(guardTail ? `${guardReason} Agent stderr: ${guardTail}` : guardReason))
  }
  if (aborted) return fail(new Error(args.abortReason ?? 'pi aborted'))
  if (code !== 0) {
    // A non-zero exit is the OTHER way a proxy refusal can surface (Pi crashing rather than
    // exiting 0 after exhausting retries), so classify it here too — otherwise a 401/402/429 that
    // happens to crash Pi would read as a generic agent failure. Redact the transcript slice
    // before it becomes the detail: unlike the exit-0 path below, this was previously
    // interpolated unscrubbed.
    const raw = (stderrTail || stdoutTail).slice(-500)
    return fail(piRunFailure(`pi exited with code ${code}: ${redactSecrets(raw)}`, raw))
  }
  const tail = redactSecrets(stderrTail.trim()).slice(-1500)
  // Pi can exit 0 even when the agent run ended in a hard error (e.g. every model call failed and
  // its retries were exhausted): the process completed, but the agent did not. Exit code alone
  // then reads as success, and a run that RESUMED a branch with prior commits would even open a
  // PR off work this pass never produced.
  const runError = reduction.terminalError()
  if (runError) {
    const scrubbed = redactSecrets(runError).slice(0, 1000)
    return fail(piRunFailure(tail ? `${scrubbed} Agent stderr: ${tail}` : scrubbed, runError))
  }
  if (!reduction.sawTerminalRecord && droppedLines > 0) {
    // The check above answered "no terminal failure" from having seen no terminal record AT ALL,
    // and the reader dropped at least one oversized one — so the record that decides this
    // question is exactly the record most likely to have been dropped (`agent_end` carries the
    // run's whole transcript). Resolving here would report a hard-failed run as a success, which
    // is the case that check exists to prevent, so refuse to certify it instead.
    // `no-usable-output` because that is literally what happened: the run finished and its
    // terminal report never reached us.
    const detail =
      `pi exited 0 but its terminal record was dropped for exceeding the JSONL line cap ` +
      `(${droppedLines} oversized record(s)), so the run's outcome is unknown`
    return fail(new HarnessFailure('no-usable-output', tail ? `${detail}. ${tail}` : detail))
  }
  return {
    ok: true,
    outcome: { ...reduction.reduce(stdoutTail), ...(tail ? { stderrTail: tail } : {}) },
  }
}

/**
 * Build the rejection for a failed Pi run: if its terminal text points at the LLM proxy
 * refusing every model call (auth/quota/rate-limit), stamp the structured `llm-upstream`
 * cause with the remedy APPENDED after the detail (keeping the raw line first, matching the
 * git/PR-open classifiers); otherwise a plain Error (→ the generic `agent` cause). Shared by
 * both the exit-0 terminal-error path and the non-zero exit path so a proxy refusal is
 * classified the same whether Pi survives it or crashes on it.
 */
function piRunFailure(detail: string, sourceText: string): Error {
  const remedy = classifyLlmUpstreamError(sourceText)
  return remedy ? new HarnessFailure('llm-upstream', `${detail}\n${remedy}`) : new Error(detail)
}

/**
 * Classify a terminal run error whose text points at the LLM PROXY rejecting every model call
 * (auth / quota / rate-limit) into an actionable remedy, else undefined. All model traffic goes
 * through the Worker's OpenAI-compatible proxy, so a 401/402/429 surfaced in Pi's `finalError`
 * means the leased provider key was refused, is out of credit, or was rate-limited — none of
 * which is an agent bug. This is the first-wrap-point for Pi's own error text (per the
 * error-message initiative's I6): we match it ONCE here and let the caller stamp the structured
 * `llm-upstream` cause + this remedy. Pure, so it is unit-tested over fixed error strings.
 */
export function classifyLlmUpstreamError(finalError: string): string | undefined {
  const s = finalError.toLowerCase()
  // 402 / quota / credit — check before the generic auth shape (a 402 body can also say
  // "unauthorized"-ish things, but a payment/quota signal is the more actionable cause).
  if (
    /\b402\b|payment required|insufficient (?:funds|quota|credit|balance)|out of (?:quota|credit)|quota exceeded|billing/i.test(
      finalError,
    )
  ) {
    return (
      'The model provider rejected the run: the account is out of quota or credit (HTTP 402). ' +
      'Top up or raise the limit with the provider, or switch to a provider key that has quota in ' +
      'the workspace AI key pool (Configure AI), then retry.'
    )
  }
  if (
    /\b429\b|too many requests|rate.?limit/i.test(finalError) &&
    !/\b401\b|\b402\b|\b403\b/.test(finalError)
  ) {
    return (
      'The model provider rate-limited the run (HTTP 429) and the agent exhausted its automatic ' +
      'retries. This is usually transient — wait a moment and retry. If it persists, reduce ' +
      'concurrent runs or use a provider key / plan with a higher rate limit in the AI key pool.'
    )
  }
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication|invalid.*token/i.test(s)
  ) {
    return (
      'The model provider rejected the run: the API credential was refused (HTTP 401/403). The ' +
      'provider key in the workspace AI key pool is most likely invalid, revoked, or expired — ' +
      're-enter it under the AI provider keys (Configure AI), then retry.'
    )
  }
  return undefined
}
