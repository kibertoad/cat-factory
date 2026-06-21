import type { PiRunStats } from './pi.js'
import type { HarnessKind } from './pi-workspace.js'

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
}

export interface RepoSpec {
  owner: string
  name: string
  baseBranch: string
  cloneUrl: string
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

export interface Job extends HarnessAuthFields {
  /**
   * Stable identifier for this run's job, supplied by the Worker (the execution
   * id). The harness keys the background job on it so a re-dispatched `/run`
   * (a Workflows replay) re-attaches to the running job instead of starting a
   * duplicate, and the Worker polls `GET /jobs/{jobId}` with the same value.
   */
  jobId: string
  /** Composed role + best-practice fragments; written to Pi's global AGENTS.md context. */
  systemPrompt: string
  /** The concrete task prompt handed to Pi. */
  userPrompt: string
  /** Upstream model id Pi should request (the proxy locks it anyway). */
  model: string
  /** Worker LLM proxy base URL, including /v1. */
  proxyBaseUrl?: string
  /** Signed, model-locked proxy session token (carries no provider key). */
  sessionToken?: string
  /** Short-lived GitHub installation token for clone + PR. */
  ghToken: string
  repo: RepoSpec
  /** Branch Pi's work is pushed to. */
  headBranch: string
  pr: PrSpec
  /** GitHub REST base (override for GitHub Enterprise / tests). Defaults to api.github.com. */
  githubApiBase?: string
  /**
   * Per-kind web-search guidance composed by the backend (it knows the agent kind;
   * the harness doesn't). Surfaced in Pi's context only when web search is configured
   * in the container env. Optional — older dispatchers omit it and the harness falls
   * back to a generic blurb.
   */
  webToolsGuidance?: string
  /**
   * Turn on proxy-backed web search for this run: the backend hosts a SearXNG-
   * compatible search proxy at `${proxyBaseUrl}/web-search`, so the harness points
   * Pi's `web_search` tool there with the session token as the bearer — no provider
   * key in the sandbox. Off/absent ⇒ web search is enabled only if a provider key is
   * present in the container env (the self-hosted runner-pool path).
   */
  webSearch?: boolean
}

/** The /run response. `error` (when set) marks a job-level failure. */
export interface RunResult {
  prUrl?: string
  branch?: string
  summary?: string
  /** What the agent actually did this run (surfaces no-op runs on the job view). */
  stats?: PiRunStats
  error?: string
  /**
   * Token usage from a subscription harness's CLI stream (absent for the
   * proxy-metered Pi harness). The backend folds it into the leased token's
   * rolling-window usage for usage-aware rotation + telemetry.
   */
  usage?: { inputTokens: number; outputTokens: number }
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid job: '${path}' must be a non-empty string`)
  }
  return value
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
    return {
      harness,
      subscriptionToken: str(o.subscriptionToken, 'subscriptionToken'),
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
  const dir = sanitizeServiceDirectory(repo.serviceDirectory)
  if (dir) spec.serviceDirectory = dir
  return spec
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

// ---- Bootstrap job (POST /bootstrap) --------------------------------------

/** The reference architecture clone source. */
export interface BootstrapReferenceSpec {
  owner: string
  name: string
  baseBranch: string
  cloneUrl: string
}

/** The new repository the bootstrapped contents are pushed to. */
export interface BootstrapTargetSpec {
  owner: string
  name: string
  cloneUrl: string
  defaultBranch: string
}

/** The job the Worker's ContainerRepoBootstrapper POSTs to /bootstrap. */
export interface BootstrapJob extends HarnessAuthFields {
  /**
   * Stable identifier for this run's job, supplied by the Worker (the bootstrap
   * job id). The harness keys the background job on it so a re-dispatched
   * `/bootstrap` (a Workflows replay) re-attaches to the running job instead of
   * starting a duplicate, and the Worker polls `GET /jobs/{jobId}` with it.
   */
  jobId: string
  /** Bootstrapper role prompt; written to Pi's global AGENTS.md context. */
  systemPrompt: string
  /** Free-form instructions handed to Pi as the task prompt. */
  instructions: string
  model: string
  proxyBaseUrl?: string
  sessionToken?: string
  ghToken: string
  /** Reference architecture to clone + adapt; omitted for a from-scratch scaffold. */
  reference?: BootstrapReferenceSpec
  target: BootstrapTargetSpec
  githubApiBase?: string
}

/** The /bootstrap response. `error` (when set) marks a job-level failure. */
export interface BootstrapResult {
  defaultBranch?: string
  summary?: string
  /** What the agent actually did this run (surfaces no-op runs on the job view). */
  stats?: PiRunStats
  error?: string
}

/** Validate + narrow an untrusted body into a {@link BootstrapJob}, throwing on bad input. */
export function parseBootstrapJob(input: unknown): BootstrapJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const target = (o.target ?? {}) as Record<string, unknown>
  // `reference` is optional: present for a clone-and-adapt run, absent for a
  // from-scratch scaffold. Only validate its shape when it is supplied.
  const reference =
    o.reference == null
      ? undefined
      : (() => {
          const r = o.reference as Record<string, unknown>
          return {
            owner: str(r.owner, 'reference.owner'),
            name: str(r.name, 'reference.name'),
            baseBranch: str(r.baseBranch, 'reference.baseBranch'),
            cloneUrl: str(r.cloneUrl, 'reference.cloneUrl'),
          }
        })()
  const job: BootstrapJob = {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    instructions: str(o.instructions, 'instructions'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    ...(reference ? { reference } : {}),
    target: {
      owner: str(target.owner, 'target.owner'),
      name: str(target.name, 'target.name'),
      cloneUrl: str(target.cloneUrl, 'target.cloneUrl'),
      defaultBranch: str(target.defaultBranch, 'target.defaultBranch'),
    },
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
  // Only after all fields are present: refuse to send the token to a host that
  // isn't an allowed GitHub host. `reference` is optional, so guard it.
  if (job.reference) assertAllowedHost(job.reference.cloneUrl, 'reference.cloneUrl')
  assertAllowedHost(job.target.cloneUrl, 'target.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}

// ---- Blueprint job (POST /blueprint) --------------------------------------

/** How a blueprint run treats any blueprint already in the repo. */
export type BlueprintMode = 'create' | 'update'

/**
 * The job the Worker's ContainerBlueprinter POSTs to /blueprint. The Blueprinter
 * agent clones `repo` at `branch`, (re)generates the `blueprints/` folder — the
 * canonical `blueprint.json` tree plus its markdown renderings — and commits the
 * result back onto `branch`. Unlike a bootstrap it never resets history or
 * force-pushes: it adds one commit to an existing branch (the repo's default
 * branch after a bootstrap, or the implementation step's PR branch in a pipeline).
 */
export interface BlueprintJob extends HarnessAuthFields {
  /** Stable job id (the blueprint run id); keys the background job + poll endpoint. */
  jobId: string
  /** Blueprinter role prompt; written to Pi's global AGENTS.md context. */
  systemPrompt: string
  /** Free-form guidance handed to Pi as the task prompt (focus areas, granularity). */
  instructions: string
  model: string
  proxyBaseUrl?: string
  sessionToken?: string
  ghToken: string
  repo: RepoSpec
  /** Branch to clone and commit the regenerated blueprint onto. */
  branch: string
  /** `create` ignores any existing blueprint; `update` refines it in place. */
  mode: BlueprintMode
  githubApiBase?: string
}

/** The /blueprint response. `service` (when set) is the decomposition tree to ingest. */
export interface BlueprintResult {
  /** The service → modules tree the agent produced (for board ingest). */
  service?: unknown
  summary?: string
  stats?: PiRunStats
  error?: string
  /** Subscription-harness CLI token usage (absent for the proxy-metered Pi harness). */
  usage?: { inputTokens: number; outputTokens: number }
}

/** Validate + narrow an untrusted body into a {@link BlueprintJob}, throwing on bad input. */
export function parseBlueprintJob(input: unknown): BlueprintJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const mode = o.mode === 'update' ? 'update' : 'create'
  const job: BlueprintJob = {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    instructions: str(o.instructions, 'instructions'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: parseRepoSpec(repo),
    branch: str(o.branch, 'branch'),
    mode,
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}

// ---- Requirements-writer job (POST /requirements) -------------------------

/** One task's collected (clarified) requirements, aggregated into the service doc. */
export interface RequirementsTaskContext {
  /** Board block id of the task (provenance / traceability). */
  id: string
  title: string
  description: string
}

/**
 * The job the Worker's ContainerAgentExecutor POSTs to /requirements. The
 * requirements-writer agent clones `branch` (the implementation branch the coder
 * will resume — created from `repo.baseBranch` if it does not exist yet), reads any
 * existing `requirements/requirements.json`, and (re)generates the unified,
 * PRESCRIPTIVE requirements document for the service from the combined `tasks`
 * context. The harness deterministically renders that document into the in-repo
 * `requirements/` folder (the canonical `requirements.json`, the `overview.md` /
 * `rules.md` markdown, the `version.json` manifest and the Gherkin
 * `features/*.feature` files) and commits it onto `branch`. Like the blueprint it
 * adds one commit to a branch — it never resets history or force-pushes.
 */
export interface RequirementsJob extends HarnessAuthFields {
  /** Stable job id (the execution id); keys the background job + poll endpoint. */
  jobId: string
  /** Requirements-writer role prompt; written to Pi's global AGENTS.md context. */
  systemPrompt: string
  /** Free-form guidance handed to Pi as the task prompt. */
  instructions: string
  model: string
  proxyBaseUrl?: string
  sessionToken?: string
  ghToken: string
  repo: RepoSpec
  /** Branch to clone (or create from base) and commit the requirements onto. */
  branch: string
  /** The collected requirements of every task under the service frame (for aggregation). */
  tasks: RequirementsTaskContext[]
  githubApiBase?: string
}

/** The /requirements response. `requirements` (when set) is the doc to ingest. */
export interface RequirementsResult {
  /** The unified requirements document the agent produced (for board ingest). */
  requirements?: unknown
  summary?: string
  stats?: PiRunStats
  error?: string
  /** Subscription-harness CLI token usage (absent for the proxy-metered Pi harness). */
  usage?: { inputTokens: number; outputTokens: number }
}

/** Validate + narrow an untrusted body into a {@link RequirementsJob}, throwing on bad input. */
export function parseRequirementsJob(input: unknown): RequirementsJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  // `tasks` is lenient: drop anything malformed rather than reject the whole job —
  // the worst case is a thinner aggregation context, not a failed run.
  const tasks: RequirementsTaskContext[] = Array.isArray(o.tasks)
    ? (o.tasks as unknown[])
        .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
        .map((t) => ({
          id: typeof t.id === 'string' ? t.id : '',
          title: typeof t.title === 'string' ? t.title : '',
          description: typeof t.description === 'string' ? t.description : '',
        }))
        .filter((t) => t.title !== '' || t.description !== '')
    : []
  const job: RequirementsJob = {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    instructions: str(o.instructions, 'instructions'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: parseRepoSpec(repo),
    branch: str(o.branch, 'branch'),
    tasks,
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}

// ---- CI-fixer job (POST /ci-fix) ------------------------------------------

/**
 * The job the Worker's ContainerAgentExecutor POSTs to /ci-fix when a PR's CI is
 * red. The fixer clones the PR head `branch`, runs the failing build/tests, fixes
 * them and pushes back onto the SAME branch (no new branch, no new PR) so CI
 * re-runs. The failing-check summary is folded into `userPrompt` by the Worker.
 */
export interface CiFixerJob extends HarnessAuthFields {
  jobId: string
  systemPrompt: string
  userPrompt: string
  model: string
  proxyBaseUrl?: string
  sessionToken?: string
  ghToken: string
  repo: RepoSpec
  /** The PR head branch to clone and push fixes onto. */
  branch: string
  githubApiBase?: string
  /** Per-kind web-search guidance (backend-composed); surfaced only when web search is on. */
  webToolsGuidance?: string
  /** Enable proxy-backed web search for this run (see {@link Job.webSearch}). */
  webSearch?: boolean
}

/** The /ci-fix response. `pushed` says whether a fix commit was pushed. */
export interface CiFixerResult {
  pushed?: boolean
  summary?: string
  stats?: PiRunStats
  error?: string
  /** Subscription-harness CLI token usage (absent for the proxy-metered Pi harness). */
  usage?: { inputTokens: number; outputTokens: number }
}

/** Validate + narrow an untrusted body into a {@link CiFixerJob}, throwing on bad input. */
export function parseCiFixerJob(input: unknown): CiFixerJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const job: CiFixerJob = {
    jobId: str(o.jobId, 'jobId'),
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
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}

// ---- Conflict-resolver job (POST /resolve-conflicts) ----------------------

/**
 * The job the Worker's ContainerAgentExecutor POSTs to /resolve-conflicts when a
 * PR cannot be merged because it conflicts with its base. The resolver clones the
 * PR head `branch` (full history), merges `repo.baseBranch` into it to surface the
 * conflicts, runs Pi to resolve them, completes the merge commit and pushes back
 * onto the SAME branch (no new branch / PR) so the PR becomes mergeable and CI
 * re-runs. Like the CI-fixer it works on the existing PR branch in place.
 */
export interface ConflictResolverJob extends HarnessAuthFields {
  jobId: string
  systemPrompt: string
  userPrompt: string
  model: string
  proxyBaseUrl?: string
  sessionToken?: string
  ghToken: string
  repo: RepoSpec
  /** The PR head branch to clone, merge the base into, and push the resolution onto. */
  branch: string
  githubApiBase?: string
}

/** The /resolve-conflicts response. `resolved` says whether the branch is now mergeable. */
export interface ConflictResolverResult {
  resolved?: boolean
  summary?: string
  stats?: PiRunStats
  error?: string
  /** Subscription-harness CLI token usage (absent for the proxy-metered Pi harness). */
  usage?: { inputTokens: number; outputTokens: number }
}

/** Validate + narrow an untrusted body into a {@link ConflictResolverJob}, throwing on bad input. */
export function parseConflictResolverJob(input: unknown): ConflictResolverJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const job: ConflictResolverJob = {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    userPrompt: str(o.userPrompt, 'userPrompt'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: parseRepoSpec(repo),
    branch: str(o.branch, 'branch'),
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}

// ---- Merger job (POST /merge) ---------------------------------------------

/**
 * The job the Worker's ContainerAgentExecutor POSTs to /merge. The merger clones
 * the PR head `branch`, assesses the diff vs `repo.baseBranch` (complexity / risk
 * / impact) and returns ONLY a JSON assessment — it makes NO commits (the Worker
 * performs the real merge through the GitHub API on the engine's verdict).
 */
export interface MergerJob extends HarnessAuthFields {
  jobId: string
  systemPrompt: string
  instructions: string
  model: string
  proxyBaseUrl?: string
  sessionToken?: string
  ghToken: string
  repo: RepoSpec
  /** The PR head branch to clone and assess against the base branch. */
  branch: string
  /** The PR number, for the agent's context (optional). */
  prNumber?: number
  githubApiBase?: string
}

/** The /merge response. `assessment` (when set) is the scores object to ingest. */
export interface MergerResult {
  assessment?: unknown
  summary?: string
  stats?: PiRunStats
  error?: string
  /** Subscription-harness CLI token usage (absent for the proxy-metered Pi harness). */
  usage?: { inputTokens: number; outputTokens: number }
}

/** Validate + narrow an untrusted body into a {@link MergerJob}, throwing on bad input. */
export function parseMergerJob(input: unknown): MergerJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const job: MergerJob = {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    instructions: str(o.instructions, 'instructions'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: parseRepoSpec(repo),
    branch: str(o.branch, 'branch'),
    ...(typeof o.prNumber === 'number' ? { prNumber: o.prNumber } : {}),
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}

/** Validate + narrow an untrusted body into a {@link Job}, throwing on bad input. */
export function parseJob(input: unknown): Job {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const repo = (o.repo ?? {}) as Record<string, unknown>
  const pr = (o.pr ?? {}) as Record<string, unknown>
  const job: Job = {
    jobId: str(o.jobId, 'jobId'),
    systemPrompt: str(o.systemPrompt, 'systemPrompt'),
    userPrompt: str(o.userPrompt, 'userPrompt'),
    model: str(o.model, 'model'),
    ...parseHarnessAuth(o),
    ghToken: str(o.ghToken, 'ghToken'),
    repo: parseRepoSpec(repo),
    headBranch: str(o.headBranch, 'headBranch'),
    pr: {
      title: str(pr.title, 'pr.title'),
      body: typeof pr.body === 'string' ? pr.body : '',
    },
    ...(typeof o.githubApiBase === 'string' ? { githubApiBase: o.githubApiBase } : {}),
    ...(typeof o.webToolsGuidance === 'string' ? { webToolsGuidance: o.webToolsGuidance } : {}),
    ...(o.webSearch === true ? { webSearch: true } : {}),
  }
  // Only after all fields are present: refuse to send the token to a host that
  // isn't an allowed GitHub host.
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  return job
}
