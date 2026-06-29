import type { PiRunStats } from './pi.js'
import type { HarnessKind } from './pi-workspace.js'
import type { FailureCause } from './failure.js'

// The job the Worker's ContainerAgentExecutor POSTs to /run. Kept as plain
// types with a hand-rolled validator so the image needs no schema dependency.
// `ghToken`, `sessionToken` and `subscriptionToken` are secrets: they are
// consumed (moved into env / git config) and never logged.

/**
 * Per-job auth fields, shared across every job shape. The Pi harness carries the
 * proxy base URL + a model-locked session token; the subscription harnesses
 * (Claude Code / Codex) carry a leased subscription token instead and talk direct
 * to the vendor. `harness` selects which; absent ⇒ Pi.
 */
export interface HarnessAuthFields {
  harness?: HarnessKind
  /** Worker LLM proxy base URL, including /v1 (Pi harness only). */
  proxyBaseUrl?: string
  /** Signed, model-locked proxy session token (Pi harness only). */
  sessionToken?: string
  /** Leased subscription credential (Claude Code OAuth token / Codex auth.json). */
  subscriptionToken?: string
  /**
   * Anthropic-compatible base URL for a non-Anthropic Claude-Code vendor (GLM via
   * Z.ai, Kimi via Moonshot). Present ⇒ the claude-code runner points
   * ANTHROPIC_BASE_URL there with ANTHROPIC_AUTH_TOKEN; absent ⇒ Anthropic itself
   * (CLAUDE_CODE_OAUTH_TOKEN against api.anthropic.com).
   */
  subscriptionBaseUrl?: string
  /**
   * Native local execution: the `claude-code` / `codex` CLI runs with the developer's
   * OWN ambient login (`~/.claude` / `~/.codex`) instead of a leased subscription token.
   * Set only by the local native transport; when true `subscriptionToken` is not required.
   */
  ambientAuth?: boolean
}

export interface RepoSpec {
  owner: string
  name: string
  baseBranch: string
  cloneUrl: string
  /**
   * The VCS provider the repo lives on, when the dispatcher set it. Selects GitHub-PR vs
   * GitLab-MR for the "open the PR" call AUTHORITATIVELY (rather than guessing from the
   * clone URL host, which can't recognise an arbitrarily-named self-managed GitLab). Absent
   * ⇒ inferred from the clone URL.
   */
  provider?: 'github' | 'gitlab'
  /**
   * For a monorepo service, the subdirectory (relative to the repo root, e.g.
   * `packages/api`) the agent should run within. Sanitised on parse to a safe
   * relative path so it can never escape the checkout. Absent ⇒ run at the repo root.
   */
  serviceDirectory?: string
}

export interface PrSpec {
  title: string
  body: string
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid job: '${path}' must be a non-empty string`)
  }
  return value
}

/** A positive finite integer, or undefined for any other input (silently ignored). */
function posInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

/**
 * Parse the optional per-job progress-guard overrides. Each knob must be a positive
 * int; a malformed value is dropped (the run keeps the env / default for that knob).
 * This only validates the SHAPE — it does NOT enforce loosen-only. The loosen-only
 * guarantee (an override can only raise a knob, never tighten it below the base) is
 * applied later, where the override meets the base, by {@link mergeGuardLimits}. So a
 * tighter-than-default value parses fine here and is clamped back up to the base there.
 * Returns undefined when nothing usable was supplied so the job body stays sparse.
 */
function parseGuardLimits(value: unknown): GuardLimitsSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const spec: GuardLimitsSpec = {}
  const noEdit = posInt(o.maxToolCallsWithoutEdit)
  const errors = posInt(o.maxConsecutiveErrors)
  const web = posInt(o.maxConsecutiveWebCalls)
  if (noEdit !== undefined) spec.maxToolCallsWithoutEdit = noEdit
  if (errors !== undefined) spec.maxConsecutiveErrors = errors
  if (web !== undefined) spec.maxConsecutiveWebCalls = web
  return Object.keys(spec).length > 0 ? spec : undefined
}

/**
 * Parse the shared per-job auth fields, validating per harness: a subscription
 * harness (`claude-code` / `codex`) requires `subscriptionToken`; the default Pi
 * harness requires `proxyBaseUrl` + `sessionToken`.
 */
function parseHarnessAuth(o: Record<string, unknown>): HarnessAuthFields {
  const harness =
    o.harness === 'claude-code' || o.harness === 'codex' || o.harness === 'pi'
      ? (o.harness as HarnessKind)
      : undefined
  if (harness === 'claude-code' || harness === 'codex') {
    // Native ambient auth uses the developer's own CLI login, so no leased token is
    // required (and none should be sent); otherwise the subscription token is mandatory.
    const ambientAuth = o.ambientAuth === true
    return {
      harness,
      ...(ambientAuth
        ? { ambientAuth: true }
        : { subscriptionToken: str(o.subscriptionToken, 'subscriptionToken') }),
      ...(typeof o.subscriptionBaseUrl === 'string' && o.subscriptionBaseUrl
        ? { subscriptionBaseUrl: o.subscriptionBaseUrl }
        : {}),
    }
  }
  return {
    harness,
    proxyBaseUrl: str(o.proxyBaseUrl, 'proxyBaseUrl'),
    sessionToken: str(o.sessionToken, 'sessionToken'),
  }
}

/**
 * Coerce a body-supplied monorepo service directory into a SAFE relative path, or
 * undefined when absent/empty. Normalises separators, strips leading/trailing
 * slashes, and rejects anything that could escape the checkout (absolute paths or a
 * `..` segment) — the agent's cwd is built from this, so a hostile value must never
 * point outside the cloned repo.
 */
function sanitizeServiceDirectory(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (!normalized) return undefined
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return undefined
  if (segments.some((s) => s === '..')) {
    throw new Error("Invalid job: 'repo.serviceDirectory' must be a path inside the repo")
  }
  return segments.join('/')
}

/** Parse the shared repo spec, including the optional monorepo service subdirectory. */
function parseRepoSpec(repo: Record<string, unknown>): RepoSpec {
  const spec: RepoSpec = {
    owner: str(repo.owner, 'repo.owner'),
    name: str(repo.name, 'repo.name'),
    baseBranch: str(repo.baseBranch, 'repo.baseBranch'),
    cloneUrl: str(repo.cloneUrl, 'repo.cloneUrl'),
  }
  const provider = parseVcsProvider(repo.provider)
  if (provider) spec.provider = provider
  const dir = sanitizeServiceDirectory(repo.serviceDirectory)
  if (dir) spec.serviceDirectory = dir
  return spec
}

/** Parse the optional `repo.provider` discriminator (defaults to undefined ⇒ host inference). */
function parseVcsProvider(value: unknown): 'github' | 'gitlab' | undefined {
  if (value === undefined || value === null) return undefined
  if (value === 'github' || value === 'gitlab') return value
  throw new Error("Invalid job: 'repo.provider' must be 'github' or 'gitlab'")
}

// ---- Host allowlist -------------------------------------------------------
// The short-lived GitHub installation token is sent (a) to the clone/push remote
// over HTTPS and (b) to the REST API base. A body-supplied URL pointing at an
// attacker-named host would exfiltrate that token, so every such URL's host is
// checked against an allowlist before use. Defaults to github.com /
// api.github.com; a GitHub Enterprise deployment can add its host via env.

/** Hosts the harness is willing to send the installation token to. */
export function allowedGithubHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(['github.com', 'api.github.com'])
  const enterprise = env.GITHUB_ENTERPRISE_HOST?.trim().toLowerCase()
  if (enterprise) hosts.add(enterprise)
  // Optional extra allowlist (comma-separated) for tests / bespoke deployments.
  for (const h of (env.GITHUB_ALLOWED_HOSTS ?? '').split(',')) {
    const t = h.trim().toLowerCase()
    if (t) hosts.add(t)
  }
  return hosts
}

/**
 * Reject a URL whose host isn't an allowed GitHub host. `file://` clone sources
 * are local (no token leaves the box) and so are always permitted; anything else
 * must be http(s) to an allowlisted host.
 */
function assertAllowedHost(
  rawUrl: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error(`Invalid job: '${path}' must be a valid URL`)
  }
  if (url.protocol === 'file:') return
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid job: '${path}' must be an https or file URL`)
  }
  const host = url.hostname.toLowerCase()
  if (!allowedGithubHosts(env).has(host)) {
    throw new Error(`Invalid job: '${path}' host '${host}' is not an allowed GitHub host`)
  }
}

// ---- Shared repo-bootstrap target ---------------------------------------

/** The new repository a repo-bootstrap run force-pushes its fresh history to. */
export interface BootstrapTargetSpec {
  owner: string
  name: string
  cloneUrl: string
  defaultBranch: string
}

// ---- Generic agent job (POST /jobs, kind=agent) ---------------------------
//
// The single, manifest-driven kind that subsumes the bespoke per-kind handlers. The
// backend decides WHAT the agent does (read-only explore vs edit-and-push coding) and
// passes it as data; the harness stays a generic LLM-over-a-checkout runner with no
// per-agent-kind code. Mechanical work (rendering artifact files, opening structured
// results onto the board) is the backend's job — done before/after this run via the
// RepoFiles port — never here.

/** How the generic agent runs: read-only exploration, or edit-and-push coding. */
export type AgentMode = 'explore' | 'coding'

/**
 * Explore mode: how a container agent stands its dependencies up before the run (the
 * tester). `local` brings the service's docker-compose infra up on localhost for the
 * duration of the run; `ephemeral` is a no-op stand-up (the env is already deployed and
 * its URL reaches the agent through its prompt). Absent ⇒ the harness manages no infra.
 */
export interface AgentInfraSpec {
  /** `local` stands infra up via docker-compose; `ephemeral` tests a deployed env. */
  environment: 'local' | 'ephemeral'
  /** Local mode: the service declared no infra dependencies (spin nothing up). */
  noInfraDependencies?: boolean
  /** Local mode: repo-relative docker-compose path to stand the dependencies up. */
  composePath?: string
  /** Ephemeral mode: the provisioned environment URL (echoed for context only). */
  environmentUrl?: string
}

/**
 * Coding mode (repo bootstrap): the divergent push of a bootstrap run. Instead of pushing
 * a work branch on the cloned repo, the agent's result is force-pushed as a fresh
 * single-commit history to a SEPARATE, pre-created target repository's default branch.
 * Clone-and-adapt: `job.repo` is the reference architecture to clone + adapt, `target` is
 * the new repo. From-scratch (`fromScratch`): start from an empty directory (the agent
 * scaffolds), `job.repo` is unused as a clone source. Absent ⇒ the ordinary coding flow.
 */
export interface AgentBootstrapSpec {
  /** The new repository the bootstrapped contents are pushed to (the push target). */
  target: BootstrapTargetSpec
  /** Scaffold from an empty directory instead of cloning `job.repo` (no reference). */
  fromScratch?: boolean
}

/**
 * A linked-context file the backend prepared (requirements / RFC / PRD / tracker issue)
 * for the harness to materialise under CONTEXT_DIR in the checkout, so the agent can read
 * it on demand. The harness can't reach Jira/GitHub itself, so all such context is fetched
 * and shipped here up front. `path` is sanitised to a safe basename on parse.
 */
export interface ContextFileSpec {
  path: string
  title: string
  url: string
  content: string
}

/** How an explore agent's reply is consumed. */
export interface AgentOutputSpec {
  /** `prose` keeps the reply text; `structured` parses (and optionally repairs) it to JSON. */
  kind: 'prose' | 'structured'
  /** Compact shape description fed to the one-shot structured-output repair call. */
  shapeHint?: string
  /** Whether to attempt the one-shot repair on a malformed reply (structured only). */
  repair?: boolean
  /**
   * Fail the run LOUDLY when the FINAL answer is unusable (cut off at the output ceiling,
   * or empty) instead of repairing it — opt-in for kinds whose JSON deliverable is handed
   * onward to be parsed/committed (e.g. the spec-writer). Absent ⇒ off.
   */
  failOnUnusableFinal?: boolean
}

/**
 * The generic agent job. `mode` selects the flow; the remaining fields are the union
 * the two flows need. Explore: clone `branch`, run read-only, return prose (or a parsed
 * `custom` JSON object when `output.kind==='structured'`). Coding: clone `branch` (or
 * resume `newBranch`), run, commit + push to `pushBranch`, and open `pr` when one is set
 * and the run produced changes.
 */
export interface AgentJob extends HarnessAuthFields {
  jobId: string
  mode: AgentMode
  systemPrompt: string
  userPrompt: string
  model: string
  ghToken: string
  repo: RepoSpec
  /** The branch to clone (the backend resolves base/pr/work to a concrete name). */
  branch: string
  githubApiBase?: string
  webToolsGuidance?: string
  webSearch?: boolean
  /** Full-history clone (needed to diff against / merge the base). Default shallow. */
  full?: boolean
  /**
   * Coding mode (conflict-resolver): merge `origin/<mergeBase>` into the cloned PR branch
   * to surface the Git conflicts, run the agent to resolve them, then complete the merge
   * commit and push back onto the SAME branch (no new branch / PR). Requires `full` so the
   * merge base + `origin/<mergeBase>` are present. Absent ⇒ the ordinary coding flow.
   */
  mergeBase?: string
  /**
   * Coding mode (repo bootstrap): force-push the agent's output as a fresh single-commit
   * history to a separate, pre-created target repo (clone + adapt `repo`, or scaffold from
   * scratch). Absent ⇒ the ordinary clone-edit-push-on-the-same-repo coding flow.
   */
  bootstrap?: AgentBootstrapSpec
  /** Explore mode: how to consume the reply. Absent ⇒ prose. */
  output?: AgentOutputSpec
  /**
   * Linked-context files to materialise under CONTEXT_DIR before the run (both modes).
   * The agent reads them on demand; they are kept out of any commit. Absent ⇒ none.
   */
  contextFiles?: ContextFileSpec[]
  /**
   * Explore mode: stand the service's dependencies up before the agent runs (the
   * tester). Brings the docker-compose infra up on localhost for the duration of the
   * run and tears it down afterward; a stand-up failure is non-fatal (surfaced to the
   * agent as a note). The agent makes no commits regardless. Absent ⇒ no infra managed.
   */
  infra?: AgentInfraSpec
  /** Coding mode: a fresh branch to create off the clone before running (else work on `branch`). */
  newBranch?: string
  /** Coding mode: branch the produced change is pushed to (defaults to `newBranch ?? branch`). */
  pushBranch?: string
  /** Coding mode: commit message for any work the agent left uncommitted. */
  commitMessage?: string
  /** Coding mode: open this PR when the run pushed changes. Absent ⇒ push only, no PR. */
  pr?: PrSpec
  /**
   * Coding mode: whether a no-op run (nothing changed) is a failure. The implementer
   * fails on a no-op; the in-place fixers (ci-fix / fix-tests) treat it as a non-fatal
   * no-op. Default true.
   */
  noChangesIsError?: boolean
  /**
   * Reuse a STABLE per-repo checkout (clean-sweep + fetch + switch branch) instead of a
   * fresh clone into a throwaway temp dir. Set ONLY by the local warm-pool transport,
   * whose containers are reused across runs; absent everywhere else, so every other
   * runtime keeps the ephemeral fresh-clone behaviour. The explore + ordinary coding
   * flows honour it; bootstrap (resets `.git`) and conflict-resolution (needs full
   * multi-branch state) always run ephemeral regardless.
   */
  persistentCheckout?: boolean
  /**
   * Coding mode (implementer): tail the Coder's follow-up sentinel file and stream the
   * forward-looking items it surfaces (loose ends / side-tasks / questions) out on the job
   * view, so the backend lifts them onto the run's step (the Follow-up companion). Set only
   * for the `coder` dispatch when the companion is enabled. Absent ⇒ no follow-up streaming.
   */
  streamFollowUps?: boolean
  /**
   * Per-job overrides for the anti-rabbithole progress guard, set by the backend per
   * AGENT KIND (a read-heavy kind tolerates more web/exploration before it counts as a
   * stall). Each knob is optional and falls back to the env / built-in default
   * ({@link progressGuardLimitsFromEnv}); only the knobs present here override. These are
   * loosen-only: `mergeGuardLimits` clamps each override up to the base, so a value
   * tighter than the default is ignored and a legitimately-progressing run is never
   * killed for a kind's normal working pattern. Absent ⇒ env/default for all knobs.
   */
  guardLimits?: GuardLimitsSpec
}

/** Per-job, per-knob progress-guard overrides (see {@link AgentJob.guardLimits}). */
export interface GuardLimitsSpec {
  maxToolCallsWithoutEdit?: number
  maxConsecutiveErrors?: number
  maxConsecutiveWebCalls?: number
}

/**
 * The record of standing the service's docker-compose dependencies up before a tester
 * run (explore mode, `infra.environment === 'local'`). The compose stand-up happens
 * INSIDE the container, so its output never reaches the orchestrator's provisioning-log
 * store (which records only the backend-side container/env spin-up); this carries the
 * captured (redacted + bounded) command output back structurally so the test window can
 * show WHY the dependencies failed to come up — previously this was trapped in the
 * harness's own logs. Absent for ephemeral / no-infra / no-compose-path runs.
 */
export interface InfraSetupRecord {
  /** Whether `docker compose up --wait` succeeded (the dependencies are up). */
  started: boolean
  /** The repo-relative compose file that was stood up. */
  composePath?: string
  /** Epoch ms the stand-up attempt finished. */
  at: number
  /** Wall-clock of the stand-up attempt, ms. */
  durationMs?: number
  /** Captured (redacted, tail-bounded) stdout+stderr of the stand-up command. */
  logs?: string
  /** The verbatim (redacted) failure message when stand-up failed, else absent. */
  error?: string
}

/** The generic agent response. `custom` carries a structured explore result. */
export interface AgentResult {
  summary?: string
  stats?: PiRunStats
  /** Structured explore output (the parsed JSON object) when `output.kind==='structured'`. */
  custom?: unknown
  /**
   * The tester's docker-compose stand-up record (explore mode, local infra). Carried back
   * so the backend can surface the in-container dependency stand-up logs on the Tester step
   * — the failure-class artifact the orchestrator-side provisioning logs can't capture.
   */
  infraSetup?: InfraSetupRecord
  /** Coding mode: whether a change was pushed. */
  pushed?: boolean
  prUrl?: string
  branch?: string
  /** Coding mode (bootstrap): the default branch the bootstrapped contents were pushed to. */
  defaultBranch?: string
  error?: string
  /**
   * The structured failure cause set alongside `error` on a clean-exit failure (no usable
   * output, no changes to push, unresolved conflicts, …). The job registry copies it onto
   * the job view so the backend classifies the failure without regex. See {@link FailureCause}.
   */
  failureCause?: FailureCause
  usage?: { inputTokens: number; outputTokens: number }
}

/** Parse the coding-mode bootstrap spec, or undefined when absent. Validates the target. */
function parseAgentBootstrapSpec(value: unknown): AgentBootstrapSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const t = (typeof o.target === 'object' && o.target !== null ? o.target : {}) as Record<
    string,
    unknown
  >
  const target: BootstrapTargetSpec = {
    owner: str(t.owner, 'bootstrap.target.owner'),
    name: str(t.name, 'bootstrap.target.name'),
    cloneUrl: str(t.cloneUrl, 'bootstrap.target.cloneUrl'),
    defaultBranch: str(t.defaultBranch, 'bootstrap.target.defaultBranch'),
  }
  return {
    target,
    ...(o.fromScratch === true ? { fromScratch: true } : {}),
  }
}

/**
 * Sanitise a body-supplied context filename to a safe basename within CONTEXT_DIR:
 * strip any directory part, allow only `[A-Za-z0-9._-]`, and reject empties / dotfiles
 * / `..` so a hostile value can't escape the directory or clobber repo files.
 */
function sanitizeContextFileName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const base = value.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '')
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return undefined
  return cleaned
}

/** Parse the linked-context files, dropping any malformed/unsafe entry. */
function parseContextFiles(value: unknown): ContextFileSpec[] {
  if (!Array.isArray(value)) return []
  const files: ContextFileSpec[] = []
  const used = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const path = sanitizeContextFileName(e.path)
    if (!path || used.has(path)) continue
    if (typeof e.content !== 'string') continue
    used.add(path)
    files.push({
      path,
      title: typeof e.title === 'string' ? e.title : path,
      url: typeof e.url === 'string' ? e.url : '',
      content: e.content,
    })
  }
  return files
}

/** Parse the explore-mode infra stand-up spec, or undefined when absent/unrecognised. */
function parseAgentInfraSpec(value: unknown): AgentInfraSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  const environment =
    o.environment === 'local' ? 'local' : o.environment === 'ephemeral' ? 'ephemeral' : undefined
  if (!environment) return undefined
  return {
    environment,
    ...(o.noInfraDependencies === true ? { noInfraDependencies: true } : {}),
    ...(typeof o.composePath === 'string' && o.composePath ? { composePath: o.composePath } : {}),
    ...(typeof o.environmentUrl === 'string' && o.environmentUrl
      ? { environmentUrl: o.environmentUrl }
      : {}),
  }
}

/** Validate + narrow an untrusted body into an {@link AgentJob}, throwing on bad input. */
export function parseAgentJob(input: unknown): AgentJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const mode = o.mode === 'coding' ? 'coding' : o.mode === 'explore' ? 'explore' : undefined
  if (!mode) throw new Error("Invalid job: 'mode' must be 'explore' or 'coding'")
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const output =
    typeof o.output === 'object' && o.output !== null
      ? (() => {
          const so = o.output as Record<string, unknown>
          const kind = so.kind === 'structured' ? 'structured' : 'prose'
          const spec: AgentOutputSpec = { kind }
          if (typeof so.shapeHint === 'string') spec.shapeHint = so.shapeHint
          // Carry an explicit `repair: false` through — the handler defaults to repair-on
          // when absent, so dropping `false` would silently re-enable the repair call for a
          // kind that opted out (it keys off `output.repair === false`).
          if (typeof so.repair === 'boolean') spec.repair = so.repair
          // Carry the opt-in truncation gate through (document producers set it); dropping
          // it would silently re-enable laundering a cut-off reply into a half-baked doc.
          if (so.failOnUnusableFinal === true) spec.failOnUnusableFinal = true
          return spec
        })()
      : undefined
  const pr =
    typeof o.pr === 'object' && o.pr !== null
      ? (() => {
          const p = o.pr as Record<string, unknown>
          return { title: str(p.title, 'pr.title'), body: typeof p.body === 'string' ? p.body : '' }
        })()
      : undefined
  const infra = parseAgentInfraSpec(o.infra)
  const bootstrap = parseAgentBootstrapSpec(o.bootstrap)
  const contextFiles = parseContextFiles(o.contextFiles)
  const guardLimits = parseGuardLimits(o.guardLimits)
  const job: AgentJob = {
    jobId: str(o.jobId, 'jobId'),
    mode,
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    userPrompt: str(o.userPrompt, 'userPrompt'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: parseRepoSpec(repo),
    branch: str(o.branch, 'branch'),
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
    ...(typeof o.webToolsGuidance === 'string' ? { webToolsGuidance: o.webToolsGuidance } : {}),
    ...(o.webSearch === true ? { webSearch: true } : {}),
    ...(o.full === true ? { full: true } : {}),
    ...(typeof o.mergeBase === 'string' && o.mergeBase ? { mergeBase: o.mergeBase } : {}),
    ...(bootstrap ? { bootstrap } : {}),
    ...(output ? { output } : {}),
    ...(contextFiles.length ? { contextFiles } : {}),
    ...(infra ? { infra } : {}),
    ...(typeof o.newBranch === 'string' && o.newBranch ? { newBranch: o.newBranch } : {}),
    ...(typeof o.pushBranch === 'string' && o.pushBranch ? { pushBranch: o.pushBranch } : {}),
    ...(typeof o.commitMessage === 'string' && o.commitMessage
      ? { commitMessage: o.commitMessage }
      : {}),
    ...(pr ? { pr } : {}),
    ...(o.noChangesIsError === false ? { noChangesIsError: false } : {}),
    ...(o.persistentCheckout === true ? { persistentCheckout: true } : {}),
    ...(o.streamFollowUps === true ? { streamFollowUps: true } : {}),
    ...(guardLimits ? { guardLimits } : {}),
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  // Bootstrap pushes the result to a SEPARATE target repo, so its clone URL must be an
  // allowed GitHub host too (the installation token is sent to it on the force-push).
  if (job.bootstrap) assertAllowedHost(job.bootstrap.target.cloneUrl, 'bootstrap.target.cloneUrl')
  return job
}
