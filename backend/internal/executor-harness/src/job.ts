import type { HarnessCallMetric, PiRunStats } from './pi.js'
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

/**
 * A connected service's repo to check out as a SIBLING alongside the primary during a
 * multi-repo coding run (service-connections phase 3). The agent clones every peer repo
 * into a sibling directory under the workspace root, makes the coherent cross-service
 * change, and the harness opens ONE PR per peer repo it actually changed. The clone URL is
 * host-allowlisted exactly like the primary `repo.cloneUrl`.
 */
export interface PeerRepoSpec {
  repo: RepoSpec
  /** The involved service frame this repo resolved from, echoed back on the peer PR. */
  frameId?: string
  /**
   * The work branch to create off the peer's base and push (the shared `cat-factory/<block>`).
   * Present for a COING fan-out (coder / ci-fixer). Absent for a READ-ONLY explore fan-out
   * (the bug-investigator), which only clones the peer to read it and never pushes.
   */
  newBranch?: string
  /**
   * The EXISTING branch to check the peer out at for a READ-ONLY explore fan-out (the `merger`
   * scoring the combined diff clones each peer at its PR branch so the diff sees the PR change).
   * Absent ⇒ the peer is cloned at its repo default branch (the bug-investigator). Ignored on the
   * coding fan-out, which creates `newBranch` instead.
   */
  cloneBranch?: string
  /** Open a PR/MR in this peer when set AND the run changed the peer (skipped for a clean repo). */
  pr?: PrSpec
  /** Per-repo GitHub token; defaults to the job's `ghToken` (one installation per workspace today). */
  ghToken?: string
}

/**
 * A repository checked out READ-ONLY as a sibling alongside the primary during a
 * document-authoring coding run — the doc-writer reads it (to reuse existing solutions as a
 * reference) but the harness never creates a branch, commits, or opens a PR for it. Deliberately
 * carries NO branch/PR fields (unlike {@link PeerRepoSpec}), so it is structurally impossible to
 * push: the read-only guarantee is enforced by the shape itself, by cloning at the repo's own
 * base branch with no work branch, and by skipping the leg in the push phase. The clone URL is
 * host-allowlisted exactly like the primary `repo.cloneUrl`.
 */
export interface ReferenceRepoSpec {
  repo: RepoSpec
  /** Per-repo GitHub token; defaults to the job's `ghToken` (one installation per workspace today). */
  ghToken?: string
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
 * A valid TCP port (1..65535), or undefined for anything else. The backend already validates
 * frontend ports against this range, but the harness re-checks at its untrusted-body boundary:
 * an out-of-range value can never bind, so dropping it falls back to the harness default rather
 * than spawning a server that fails to listen.
 */
function port(value: unknown): number | undefined {
  const n = posInt(value)
  return n !== undefined && n <= 65535 ? n : undefined
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
 * Parse the optional Ralph-loop validation spec. Requires a non-empty `command` string (the
 * completion criterion the harness runs); `progressPath`/`iteration` are optional metadata.
 * Returns undefined when absent or malformed (a coding run then behaves like any other — no
 * post-commit validation). See {@link ValidationSpec}.
 */
function parseValidationSpec(value: unknown): ValidationSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  if (typeof o.command !== 'string' || o.command.trim() === '') return undefined
  const iteration = posInt(o.iteration)
  return {
    command: o.command,
    ...(typeof o.progressPath === 'string' && o.progressPath
      ? { progressPath: o.progressPath }
      : {}),
    ...(iteration !== undefined ? { iteration } : {}),
  }
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
function sanitizeServiceDirectory(
  value: unknown,
  field = 'repo.serviceDirectory',
): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
  if (!normalized) return undefined
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return undefined
  if (segments.some((s) => s === '..')) {
    throw new Error(`Invalid job: '${field}' must be a path inside the repo`)
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

/**
 * Parse the optional multi-repo peer list (service-connections phase 3). Each entry carries a
 * full {@link RepoSpec} (validated + sanitised like the primary), the work branch to push, and
 * an optional PR + per-repo token. A malformed list throws; an absent one yields `[]`.
 */
function parsePeerRepos(value: unknown): PeerRepoSpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Invalid job: 'peerRepos' must be an array")
  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Invalid job: 'peerRepos[${i}]' must be an object`)
    }
    const e = entry as Record<string, unknown>
    const spec: PeerRepoSpec = {
      repo: parseRepoSpec((e.repo ?? {}) as Record<string, unknown>),
    }
    // `newBranch` is required for a coding fan-out (it pushes to it) but ABSENT for a
    // read-only explore fan-out (bug-investigator) — validate it only when present.
    if (e.newBranch !== undefined) spec.newBranch = str(e.newBranch, `peerRepos[${i}].newBranch`)
    // Read-only explore fan-out: the branch to check the peer out at (the merger's PR branch).
    if (e.cloneBranch !== undefined) {
      spec.cloneBranch = str(e.cloneBranch, `peerRepos[${i}].cloneBranch`)
    }
    if (typeof e.frameId === 'string' && e.frameId) spec.frameId = e.frameId
    if (typeof e.ghToken === 'string' && e.ghToken) spec.ghToken = e.ghToken
    if (typeof e.pr === 'object' && e.pr !== null) {
      const p = e.pr as Record<string, unknown>
      spec.pr = {
        title: str(p.title, `peerRepos[${i}].pr.title`),
        body: typeof p.body === 'string' ? p.body : '',
      }
    }
    return spec
  })
}

/**
 * Parse the optional read-only reference-repo list (document-authoring runs). Each entry carries
 * a full {@link RepoSpec} (validated + sanitised like the primary) and an optional per-repo token.
 * Any branch/PR fields on the wire are IGNORED — a reference repo is never pushed, so the parsed
 * shape has none to carry. A malformed list throws; an absent one yields `[]`.
 */
function parseReferenceRepos(value: unknown): ReferenceRepoSpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Invalid job: 'referenceRepos' must be an array")
  return value.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Invalid job: 'referenceRepos[${i}]' must be an object`)
    }
    const e = entry as Record<string, unknown>
    const spec: ReferenceRepoSpec = {
      repo: parseRepoSpec((e.repo ?? {}) as Record<string, unknown>),
    }
    if (typeof e.ghToken === 'string' && e.ghToken) spec.ghToken = e.ghToken
    return spec
  })
}

/**
 * Parse the optional `referenceBranches` list: pre-existing branch NAMES of the PRIMARY repo the
 * agent may read but never commit to (the apriori-branches reference mode). Unlike
 * {@link parseReferenceRepos} these are not sibling repos — they are fetched into the primary
 * checkout's `origin/<b>` refs (see {@link fetchReferenceBranches}). A non-string / empty entry is
 * dropped; an absent list yields `[]`. Kept simple (no git-ref grammar check) because the backend
 * validated the name at the write boundary and probed its existence at dispatch.
 */
function parseReferenceBranches(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Invalid job: 'referenceBranches' must be an array")
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
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

// ---- Private package registries ------------------------------------------
// Workspace-configured private-registry auth (npm private orgs, GitHub Packages)
// so the checkout's installs resolve private dependencies. The backend derives the
// host from a fixed vendor set, so the harness hard-allowlists where a registry
// token may be sent — a body-supplied host outside the allowlist is treated as
// forgery (token exfiltration) and rejects the job. Ecosystem-discriminated:
// entries of an unknown ecosystem are DROPPED (not an error) so later ecosystems
// (pip/maven/cargo) stay additive for an older harness image.

/** One private-registry entry: rendered into `~/.npmrc` before the agent runs. */
export interface PackageRegistrySpec {
  ecosystem: 'npm'
  /** Registry host, e.g. `registry.npmjs.org` — allowlisted, never a full URL. */
  host: string
  /** npm scopes (`@org`) routed to this registry. */
  scopes: string[]
  token: string
}

/** npm registry hosts the harness is willing to send a registry token to. */
export function allowedNpmRegistryHosts(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(['registry.npmjs.org', 'npm.pkg.github.com'])
  // Optional extra allowlist (comma-separated) for tests / bespoke deployments.
  for (const h of (env.NPM_ALLOWED_REGISTRY_HOSTS ?? '').split(',')) {
    const t = h.trim().toLowerCase()
    if (t) hosts.add(t)
  }
  return hosts
}

/** An npm scope (`@org`) — same shape the backend validates at the write boundary. */
const NPM_SCOPE_PATTERN = /^@[a-z0-9~-][a-z0-9._~-]*$/i

// A registry token is a single opaque string. Reject any whitespace / control
// character: a newline in the token would inject arbitrary lines into the rendered
// `~/.npmrc` (a second, forged registry/_authToken line). Mirrors the backend's
// write-boundary constraint so a drifted body can't slip a multiline token past.
const NPM_TOKEN_PATTERN = /^[\x21-\x7e]+$/

/** Validate the optional `packageRegistries` list (see {@link PackageRegistrySpec}). */
export function parsePackageRegistries(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PackageRegistrySpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Invalid job: 'packageRegistries' must be an array")
  const allowed = allowedNpmRegistryHosts(env)
  const entries: PackageRegistrySpec[] = []
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Invalid job: 'packageRegistries[${i}]' must be an object`)
    }
    const entry = raw as Record<string, unknown>
    // Unknown ecosystems are additive: a newer backend may send pip/maven entries an
    // older image doesn't understand yet — skip them rather than failing the job.
    if (entry.ecosystem !== 'npm') continue
    const host = str(entry.host, `packageRegistries[${i}].host`).trim().toLowerCase()
    if (!allowed.has(host)) {
      throw new Error(
        `Invalid job: 'packageRegistries[${i}].host' '${host}' is not an allowed npm registry host`,
      )
    }
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) {
      throw new Error(`Invalid job: 'packageRegistries[${i}].scopes' must be a non-empty array`)
    }
    const scopes = entry.scopes.map((scope, j) => {
      const s = str(scope, `packageRegistries[${i}].scopes[${j}]`).trim()
      if (!NPM_SCOPE_PATTERN.test(s)) {
        throw new Error(`Invalid job: 'packageRegistries[${i}].scopes[${j}]' must look like @org`)
      }
      return s
    })
    const token = str(entry.token, `packageRegistries[${i}].token`)
    if (!NPM_TOKEN_PATTERN.test(token)) {
      throw new Error(
        `Invalid job: 'packageRegistries[${i}].token' must not contain spaces or control characters`,
      )
    }
    entries.push({ ecosystem: 'npm', host, scopes, token })
  }
  return entries
}

/**
 * One sensitive test credential the tester receives: an env-var name + its (secret) value.
 * The backend seals these at rest and decrypts them at dispatch; the harness injects each as an
 * environment variable the tester's shell can read (out of band — the value is NEVER in the
 * prompt/telemetry). See {@link parseTestSecrets}.
 */
export interface TestSecretSpec {
  key: string
  value: string
}

/** A valid POSIX shell variable name (letters, digits, underscore; not starting with a digit). */
const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate the optional tester `testSecrets` list — `{ key, value }` env pairs the harness
 * injects into the run environment. Keys must be valid env-var names; toolchain-critical /
 * reserved names ({@link isReservedEnvName}) and duplicates are dropped so a drifted body can't
 * clobber PATH/NODE_OPTIONS/etc. Absent ⇒ no secrets injected.
 */
export function parseTestSecrets(value: unknown): TestSecretSpec[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Invalid job: 'testSecrets' must be an array")
  const entries: TestSecretSpec[] = []
  const seen = new Set<string>()
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`Invalid job: 'testSecrets[${i}]' must be an object`)
    }
    const entry = raw as Record<string, unknown>
    const key = str(entry.key, `testSecrets[${i}].key`).trim()
    if (!ENV_VAR_NAME_PATTERN.test(key)) {
      throw new Error(
        `Invalid job: 'testSecrets[${i}].key' must be a valid environment variable name`,
      )
    }
    if (isReservedEnvName(key) || seen.has(key)) continue
    seen.add(key)
    entries.push({ key, value: str(entry.value, `testSecrets[${i}].value`) })
  }
  return entries
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
export type AgentMode = 'explore' | 'coding' | 'preview'

/**
 * Explore mode: how a container agent stands its dependencies up before the run (the
 * tester). Two shapes, discriminated by `kind` (absent ⇒ `service`, the backend tester):
 *   - `service` — a backend service under test: `local` brings the service's
 *     docker-compose infra up on localhost for the run; `ephemeral` is a no-op stand-up
 *     (the env is already deployed and its URL reaches the agent through its prompt).
 *   - `frontend` — a frontend app under test (the self-contained UI-test flow): build the
 *     frontend, stand WireMock up for its mocked upstreams, serve the built app, and point
 *     the (`tester-ui`) agent at it. Everything runs as localhost PROCESSES in the one
 *     container (no Docker-in-Docker), so it works on Cloudflare + Apple `container` too.
 * Absent ⇒ the harness manages no infra.
 */
export type AgentInfraSpec = ServiceInfraSpec | FrontendInfraSpec

/** Backend-service tester infra (docker-compose local, or a deployed ephemeral env). */
export interface ServiceInfraSpec {
  /** Discriminant. Absent ⇒ `service` (the backend tester). */
  kind?: 'service'
  /** `local` stands infra up via docker-compose; `ephemeral` tests a deployed env. */
  environment: 'local' | 'ephemeral'
  /** Local mode: the service declared no infra dependencies (spin nothing up). */
  noInfraDependencies?: boolean
  /** Local mode: repo-relative docker-compose path to stand the dependencies up. */
  composePath?: string
  /** Ephemeral mode: the provisioned environment URL (echoed for context only). */
  environmentUrl?: string
  /**
   * The connected services "directly involved" in this task that have a LIVE ephemeral env this
   * run (service title → URL), so a cross-service integration test can reach a peer's real
   * environment. Echoed for context only (surfaced in the agent's prompt); the harness stands
   * nothing up for it. Absent when no involved peer is live.
   */
  peerEnvironments?: Record<string, string>
}

/**
 * Frontend UI-test infra (the self-contained `tester-ui` flow). The backend has already
 * resolved every backend upstream to a concrete URL — the bound service's live ephemeral
 * env URL for the service under test, `http://localhost:<wiremockPort>` for every mocked
 * upstream — and handed them here as {@link env}. The harness installs, builds (injecting
 * `env` at build time, or writing a `window.env` shim for runtime injection), stands
 * WireMock up on {@link wiremockPort} seeded from {@link wiremockMappingsPath}, serves the
 * built app on {@link servePort}, health-checks it, and tells the agent the serve URL.
 */
export interface FrontendInfraSpec {
  kind: 'frontend'
  /**
   * The frontend app's subdirectory within the checkout (a monorepo frontend). Absent ⇒ the
   * checkout root. When set, install/build/serve run there and `outputDir`/`wiremockMappingsPath`
   * are resolved relative to it.
   */
  directory?: string
  /** Package manager for install/build. Default `pnpm`. */
  packageManager?: 'pnpm' | 'npm' | 'yarn'
  /** Explicit install command, overriding the one derived from `packageManager`. */
  install?: string
  /** package.json script that produces the built app. Default `build`. */
  buildScript?: string
  /** The build's output directory, served in `static` mode. Default `dist`. */
  outputDir?: string
  /** How the built app is served: static server of `outputDir`, or run `serveScript`. */
  serveMode?: 'static' | 'command'
  /** package.json script to run when `serveMode: 'command'` (e.g. `preview`). */
  serveScript?: string
  /** The port the served app listens on inside the container. Default 4173. */
  servePort?: number
  /** Build-time env vars vs a runtime `window.env` shim. Default `build`. */
  envInjection?: 'build' | 'runtime'
  /** Resolved backend upstream env vars (name → URL) to inject. Empty names filtered out. */
  env?: Record<string, string>
  /** The WireMock mappings directory in the FE repo. Default `mocks/`. */
  wiremockMappingsPath?: string
  /** The port WireMock listens on inside the container. Default 8089. */
  wiremockPort?: number
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

/** One materialisable resource file of a skill (repo-sourced Claude Skills). */
export interface SkillResourceSpec {
  /** Path within the skill directory, e.g. `templates/report.md` (subdirs preserved, no traversal). */
  relPath: string
  content: string
}

/**
 * A repo-sourced Claude Skill to make available for a `skill` step. Materialised HARNESS-AWARE:
 * `CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md` (+ resources) for the claude-code CLI to load
 * natively, or `.cat-context/skill/<relPath>` for the Pi/codex checkout (their prompt carries the
 * instructions). A dedicated top-level body field (like `packageRegistries`), never a context file.
 */
export interface SkillSpec {
  name: string
  description: string
  instructions: string
  resources: SkillResourceSpec[]
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
 * the flows need. Explore: clone `branch`, run read-only, return prose (or a parsed
 * `custom` JSON object when `output.kind==='structured'`). Coding: clone `branch` (or
 * resume `newBranch`), run, commit + push to `pushBranch`, and open `pr` when one is set
 * and the run produced changes. Preview (local/node only): clone `branch`, build + serve
 * the frontend (`infra.kind==='frontend'`) with its other upstreams mocked and KEEP IT
 * RUNNING — no agent runs and the serve is deliberately not torn down when the job returns
 * (see {@link AgentResult.preview}).
 */
/**
 * Coding mode (Ralph loop): the programmatic completion criterion. After the coding agent
 * commits + pushes, the harness runs {@link command} in the checkout and reports its exit
 * code back on {@link AgentResult.ralphVerdict} — exit 0 means the loop is done. This is the
 * whole point of a Ralph loop's exit condition being a REAL check: the harness runs it, not
 * the model. The command runs only inside the sandboxed run container (same trust boundary
 * as the coding agent). Absent for every non-`ralph` coding run.
 */
export interface ValidationSpec {
  /** The shell command the harness runs against the checkout (exit 0 = the criterion is met). */
  command: string
  /** Repo-relative progress-log path the agent maintains (informational; the harness doesn't write it). */
  progressPath?: string
  /** 1-based iteration number, echoed back on the verdict for the engine's attempt log. */
  iteration?: number
}

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
   * Private package-registry auth (npm private orgs, GitHub Packages), rendered into
   * `~/.npmrc` before the run so the checkout's installs — the agent's own and the
   * frontend-infra stand-up's — resolve private dependencies. Hosts are hard-allowlisted
   * (see {@link allowedNpmRegistryHosts}). Absent ⇒ any stale `~/.npmrc` from a prior
   * job on a reused container is removed.
   */
  packageRegistries?: PackageRegistrySpec[]
  /**
   * A repo-sourced Claude Skill to make available for a `skill` step (see {@link SkillSpec}).
   * Materialised harness-aware before the run: natively into `CLAUDE_CONFIG_DIR/skills/<name>/`
   * for claude-code, or `.cat-context/skill/<relPath>` for Pi/codex. Absent ⇒ no skill installed.
   */
  skill?: SkillSpec
  /**
   * Tester kinds only: sensitive test credentials injected into the run's ENVIRONMENT (out of
   * band) as `{ key, value }` env pairs, so the tester's shell can read `$KEY` without the value
   * ever appearing in the prompt or telemetry. Reserved/toolchain env names are dropped at parse.
   * Absent ⇒ no secrets injected.
   */
  testSecrets?: TestSecretSpec[]
  /**
   * Explore mode: stand the service's dependencies up before the agent runs (the
   * tester). Brings the docker-compose infra up on localhost for the duration of the
   * run and tears it down afterward; a stand-up failure is non-fatal (surfaced to the
   * agent as a note). The agent makes no commits regardless. Absent ⇒ no infra managed.
   *
   * Preview mode: REQUIRED and must be the `frontend` variant — it is the whole job (build
   * + serve + WireMock, kept alive). No agent runs and, unlike the tester, the stand-up is
   * NOT torn down when the job returns.
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
   * Coding mode (implementer): connected services' repos to clone as SIBLINGS for a MULTI-REPO
   * change (service-connections phase 3). When present, the agent works with its cwd at the
   * workspace ROOT (all repos are sibling checkouts under it), and the harness opens one PR per
   * peer repo it actually changed — in addition to the primary. Absent ⇒ single-repo run.
   */
  peerRepos?: PeerRepoSpec[]
  /**
   * Coding mode (doc-writer): repositories to clone READ-ONLY as SIBLINGS for the agent to
   * reference while it drafts the document. When present the agent works at the workspace ROOT
   * (all checkouts are siblings under it); the harness clones each reference at its own base
   * branch and NEVER creates a branch, commits, or opens a PR for it. Only the primary is
   * pushed. Absent ⇒ single-repo run. Independent of {@link peerRepos} (those are writable).
   */
  referenceRepos?: ReferenceRepoSpec[]
  /**
   * Pre-existing branch names of the PRIMARY repo attached to the task as READ-ONLY reference
   * points (the apriori-branches reference mode). After the primary checkout the harness fetches
   * each into its `origin/<b>` tracking ref (best-effort per branch) so the agent can inspect it —
   * `git log origin/<b>`, two-dot `git diff origin/<b>`, `git show origin/<b>:<path>` — but never
   * commits to or pushes it (that guarantee lives in the prompt guidance, not a git constraint).
   * Distinct from {@link referenceRepos}: those are separate sibling repos; these are branches of
   * the same primary repo. Absent ⇒ none. Consumed by the coding + explore flows.
   */
  referenceBranches?: string[]
  /**
   * Explore mode (the `pr-reviewer`): the reviewed PR/MR number. Present ⇒ after the base
   * checkout the harness fetches that PR's HEAD into `origin/pr-head` (best-effort) so the
   * read-only reviewer can diff/read the PROPOSED code — files the PR adds are otherwise absent
   * from the base checkout, and the agent has no git credential to fetch the head itself. The
   * GitHub-vs-GitLab pull ref is chosen from `repo.provider` (host-inferred when absent). Absent
   * ⇒ no head fetch (every non-review run). See {@link file://./git.ts} `fetchPullRequestHead`.
   */
  reviewPrNumber?: number
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
  /**
   * Coding mode (Ralph loop): the programmatic completion command the harness runs after the
   * agent commits + pushes. Present only for a `ralph` iteration. See {@link ValidationSpec}.
   */
  validation?: ValidationSpec
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
  /**
   * Preview mode: the in-container URL the built app is served at (e.g. `http://localhost:4173`).
   * This is NOT host-reachable on its own — the container runtime publishes the serve port to an
   * ephemeral host port and the backend forms the browsable URL from that; this is echoed for
   * logging/context. Present only on a successful preview stand-up.
   */
  preview?: { url: string }
  /** Coding mode: whether a change was pushed. */
  pushed?: boolean
  prUrl?: string
  branch?: string
  /**
   * Coding mode (Ralph loop): the harness-computed verdict of the post-commit validation
   * command — whether it exited 0, its exit code, and a bounded, redacted output tail. The
   * engine reads this (never a model self-report) to decide whether the loop is done or must
   * iterate again. Present only for a `ralph` iteration ({@link AgentJob.validation} set).
   */
  ralphVerdict?: {
    validationPassed: boolean
    exitCode: number
    validationOutputTail?: string
    iteration?: number
  }
  /**
   * Coding mode (multi-repo): the PRs opened in the connected services' PEER repos, one per
   * repo the run actually changed (service-connections phase 3). Beside the own-service
   * `prUrl`/`branch`; the backend lifts these onto the block's `peerPullRequests`. Absent for
   * a single-repo run.
   */
  peerPullRequests?: { repo: string; frameId?: string; prUrl: string; branch: string }[]
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
  /**
   * Per-model-call telemetry from a subscription harness's CLI stream (absent for the
   * proxy-metered Pi harness). The backend records these into `llm_call_metrics`. See
   * {@link HarnessCallMetric}.
   */
  callMetrics?: HarnessCallMetric[]
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

/** Validate the optional `skill` field, or undefined when absent/malformed. */
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

/** Parse the explore-mode infra stand-up spec, or undefined when absent/unrecognised. */
function parseAgentInfraSpec(value: unknown): AgentInfraSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const o = value as Record<string, unknown>
  if (o.kind === 'frontend') return parseFrontendInfraSpec(o)
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
    ...(() => {
      const peers = parseStringMap(o.peerEnvironments)
      return peers ? { peerEnvironments: peers } : {}
    })(),
  }
}

/** Parse a `Record<string, string>` from untrusted input, keeping only string→non-empty-string. */
function parseStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'string' && val) out[key] = val
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Env-var names never injected from a frontend binding: spread over `process.env` at build
 * time, so any of these would break the toolchain (or enable code execution / cert overrides)
 * rather than name an upstream URL. Matched exactly (Linux env is case-sensitive); the
 * {@link RESERVED_ENV_PREFIXES} below cover whole families (`npm_config_*`, `GIT_*`, …).
 */
const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'BASH_ENV',
  'ENV',
  'SHELL',
  'IFS',
])

/**
 * Env-var name PREFIXES never injected from a frontend binding. `npm_config_*` reconfigures the
 * package manager (registry, scripts, prefix), and `GIT_*` reconfigures git — both run during a
 * frontend install/build, so a binding in either family is toolchain control, not an upstream URL.
 * Compared case-INSENSITIVELY (lower-cased here, matched lower-cased below): npm reads its config
 * env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY` is honoured just like
 * `npm_config_registry` — a case-sensitive prefix match would let the upper-cased form slip through.
 */
const RESERVED_ENV_PREFIXES = ['npm_config_', 'git_']

/**
 * Whether an env-var name is reserved (an exact name, or a reserved family prefix). The exact
 * names are canonical upper-case env vars matched verbatim (Linux env is case-sensitive, so a
 * distinct lower-cased `home` is a different, harmless var); the family PREFIXES are matched
 * case-insensitively because npm interprets `npm_config_*` regardless of case (see above).
 */
function isReservedEnvName(key: string): boolean {
  if (RESERVED_ENV_NAMES.has(key)) return true
  const lower = key.toLowerCase()
  return RESERVED_ENV_PREFIXES.some((p) => lower.startsWith(p))
}

/** Parse the frontend UI-test infra spec (`kind: 'frontend'`), tolerating missing knobs. */
function parseFrontendInfraSpec(o: Record<string, unknown>): FrontendInfraSpec {
  const packageManager =
    o.packageManager === 'pnpm' || o.packageManager === 'npm' || o.packageManager === 'yarn'
      ? o.packageManager
      : undefined
  const serveMode = o.serveMode === 'static' || o.serveMode === 'command' ? o.serveMode : undefined
  const envInjection =
    o.envInjection === 'build' || o.envInjection === 'runtime' ? o.envInjection : undefined
  // Only string→string entries survive; a non-string value is dropped so a malformed
  // binding can't inject `[object Object]` (or undefined) as an upstream URL. Reserved names
  // that would break the toolchain or enable injection (PATH, NODE_OPTIONS, LD_PRELOAD, …) are
  // dropped too: they are spread over `process.env` at build time, so a binding named `PATH`
  // would replace it with a URL and the build would no longer find its tools.
  const env: Record<string, string> = {}
  if (typeof o.env === 'object' && o.env !== null) {
    for (const [key, val] of Object.entries(o.env as Record<string, unknown>)) {
      if (key && !isReservedEnvName(key) && typeof val === 'string') env[key] = val
    }
  }
  const servePort = port(o.servePort)
  const wiremockPort = port(o.wiremockPort)
  // The app's monorepo subdirectory becomes the install/build/serve cwd, so it goes through the
  // same escape-guard as `repo.serviceDirectory` — strip slashes and reject any `..` segment so a
  // hostile value can't point the stand-up outside the cloned repo.
  const directory = sanitizeServiceDirectory(o.directory, 'frontend.directory')
  return {
    kind: 'frontend',
    ...(directory ? { directory } : {}),
    ...(packageManager ? { packageManager } : {}),
    ...(typeof o.install === 'string' && o.install ? { install: o.install } : {}),
    ...(typeof o.buildScript === 'string' && o.buildScript ? { buildScript: o.buildScript } : {}),
    ...(typeof o.outputDir === 'string' && o.outputDir ? { outputDir: o.outputDir } : {}),
    ...(serveMode ? { serveMode } : {}),
    ...(typeof o.serveScript === 'string' && o.serveScript ? { serveScript: o.serveScript } : {}),
    ...(servePort !== undefined ? { servePort } : {}),
    ...(envInjection ? { envInjection } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(typeof o.wiremockMappingsPath === 'string' && o.wiremockMappingsPath
      ? { wiremockMappingsPath: o.wiremockMappingsPath }
      : {}),
    ...(wiremockPort !== undefined ? { wiremockPort } : {}),
  }
}

// ---- Inline job (POST /jobs, kind=inline) --------------------------------
//
// A ONE-SHOT, no-checkout LLM completion run through a subscription harness CLI
// (Claude Code / Codex) on a leased subscription credential — the container analogue of
// the local host-CLI inline runner. It exists so a deployment that can't run the ambient
// CLI on the host (no `claude`/`codex` binary, or mothership mode) can still serve the
// inline LLM steps (requirements reviewer, brainstorm, task-estimator, inline document
// kinds) on a subscription model, at warm-pool latency. It clones NOTHING and pushes
// NOTHING: the CLI runs in a throwaway temp cwd and only the completion text + token usage
// come back. Auth is the SAME `HarnessAuthFields` the coding path uses (subscriptionToken +
// optional subscriptionBaseUrl, or ambientAuth), so the credential-env setup is shared.

/** The one-shot inline completion job. `harness` must be a subscription harness. */
export interface InlineJob extends HarnessAuthFields {
  jobId: string
  /** Real vendor model id, e.g. `claude-opus-4-8` / `gpt-5.5-codex`. */
  model: string
  /** Composed role + best-practice fragments (Claude: `--append-system-prompt`; Codex: prepended). */
  systemPrompt: string
  /** The concrete task/user prompt fed to the CLI over stdin. */
  userPrompt: string
  /** Advisory output cap, forwarded for parity; the one-shot CLIs don't all honour it. */
  maxOutputTokens?: number
}

/** The inline completion result: the reply text plus lifted token usage / per-call telemetry. */
export interface InlineResult {
  text: string
  /** `length` when the model hit its output cap (the reviewer rejects a truncated doc). */
  finishReason?: 'stop' | 'length'
  usage?: { inputTokens: number; outputTokens: number }
  /** Per-model-call telemetry lifted from the CLI stream (recorded into `llm_call_metrics`). */
  callMetrics?: HarnessCallMetric[]
  /** A structured failure marks a job-level failure even on a clean HTTP exit (see JobResultBase). */
  error?: string
}

/**
 * Validate + narrow an untrusted body into an {@link InlineJob}. The harness MUST be a
 * subscription harness (`claude-code` / `codex`) — the inline path never runs Pi (that goes
 * through the LLM proxy inline, not a container CLI). Reuses {@link parseHarnessAuth}, so a
 * non-ambient job requires `subscriptionToken`.
 */
export function parseInlineJob(input: unknown): InlineJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  // Validate the harness FIRST (before parseHarnessAuth, whose `pi` branch demands a proxy
  // base URL): the inline path only ever runs a subscription CLI, so a Pi/absent harness is a
  // clear inline-specific rejection rather than a confusing "proxyBaseUrl required".
  if (o.harness !== 'claude-code' && o.harness !== 'codex') {
    throw new Error("Invalid inline job: 'harness' must be 'claude-code' or 'codex'")
  }
  const auth = parseHarnessAuth(o)
  const maxOutputTokens = posInt(o.maxOutputTokens)
  return {
    jobId: str(o.jobId, 'jobId'),
    model: str(o.model, 'model'),
    // The system prompt is optional (an empty role is valid); the user prompt is required.
    systemPrompt: typeof o.systemPrompt === 'string' ? o.systemPrompt : '',
    userPrompt: str(o.userPrompt, 'userPrompt'),
    ...auth,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

/** Validate + narrow an untrusted body into an {@link AgentJob}, throwing on bad input. */
export function parseAgentJob(input: unknown): AgentJob {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Invalid job: body must be an object')
  }
  const o = input as Record<string, unknown>
  const mode =
    o.mode === 'coding'
      ? 'coding'
      : o.mode === 'explore'
        ? 'explore'
        : o.mode === 'preview'
          ? 'preview'
          : undefined
  if (!mode) throw new Error("Invalid job: 'mode' must be 'explore', 'coding' or 'preview'")
  // Preview runs NO agent (it only builds + serves the frontend), so the agent-only fields
  // (system/user prompt, model) are unused there — accept them absent rather than forcing the
  // preview dispatch to send dummy values it has no reason to supply. Every other mode still
  // requires them (throws when missing/empty), exactly as before.
  const agentField = (value: unknown, path: string): string =>
    mode === 'preview' ? (typeof value === 'string' ? value : '') : str(value, path)
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
  const peerRepos = parsePeerRepos(o.peerRepos)
  const referenceRepos = parseReferenceRepos(o.referenceRepos)
  const referenceBranches = parseReferenceBranches(o.referenceBranches)
  const bootstrap = parseAgentBootstrapSpec(o.bootstrap)
  const contextFiles = parseContextFiles(o.contextFiles)
  const packageRegistries = parsePackageRegistries(o.packageRegistries)
  const skill = parseSkillSpec(o.skill)
  const testSecrets = parseTestSecrets(o.testSecrets)
  const guardLimits = parseGuardLimits(o.guardLimits)
  const validation = parseValidationSpec(o.validation)
  const job: AgentJob = {
    jobId: str(o.jobId, 'jobId'),
    mode,
    systemPrompt: agentField(o.systemPrompt, 'systemPrompt'),
    userPrompt: agentField(o.userPrompt, 'userPrompt'),
    model: agentField(o.model, 'model'),
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
    ...(packageRegistries.length ? { packageRegistries } : {}),
    ...(skill ? { skill } : {}),
    ...(testSecrets.length ? { testSecrets } : {}),
    ...(infra ? { infra } : {}),
    ...(typeof o.newBranch === 'string' && o.newBranch ? { newBranch: o.newBranch } : {}),
    ...(typeof o.pushBranch === 'string' && o.pushBranch ? { pushBranch: o.pushBranch } : {}),
    ...(typeof o.commitMessage === 'string' && o.commitMessage
      ? { commitMessage: o.commitMessage }
      : {}),
    ...(pr ? { pr } : {}),
    ...(peerRepos.length ? { peerRepos } : {}),
    ...(referenceRepos.length ? { referenceRepos } : {}),
    ...(referenceBranches.length ? { referenceBranches } : {}),
    ...(posInt(o.reviewPrNumber) !== undefined ? { reviewPrNumber: posInt(o.reviewPrNumber) } : {}),
    ...(o.noChangesIsError === false ? { noChangesIsError: false } : {}),
    ...(o.persistentCheckout === true ? { persistentCheckout: true } : {}),
    ...(o.streamFollowUps === true ? { streamFollowUps: true } : {}),
    ...(guardLimits ? { guardLimits } : {}),
    ...(validation ? { validation } : {}),
  }
  assertAllowedHost(job.repo.cloneUrl, 'repo.cloneUrl')
  if (job.githubApiBase) assertAllowedHost(job.githubApiBase, 'githubApiBase')
  // Bootstrap pushes the result to a SEPARATE target repo, so its clone URL must be an
  // allowed GitHub host too (the installation token is sent to it on the force-push).
  if (job.bootstrap) assertAllowedHost(job.bootstrap.target.cloneUrl, 'bootstrap.target.cloneUrl')
  // Each peer repo's clone URL receives the installation token on clone/push, so it must be
  // an allowed GitHub host too — a body-supplied peer pointing at an attacker host would
  // exfiltrate the token exactly like a rogue primary clone URL.
  for (const [i, peer] of (job.peerRepos ?? []).entries()) {
    assertAllowedHost(peer.repo.cloneUrl, `peerRepos[${i}].repo.cloneUrl`)
  }
  // Each reference repo's clone URL receives the installation/PAT token on clone (read-only,
  // never pushed), so it must be an allowed host too — a body-supplied reference pointing at an
  // attacker host would exfiltrate the token exactly like a rogue peer clone URL.
  for (const [i, ref] of (job.referenceRepos ?? []).entries()) {
    assertAllowedHost(ref.repo.cloneUrl, `referenceRepos[${i}].repo.cloneUrl`)
  }
  return job
}
