import type { EnvironmentManifest, EnvironmentStatus } from '@cat-factory/kernel'
import { parse, stringify } from 'yaml'

// Pure helpers for the Docker Compose ENVIRONMENT backend: read the flat per-workspace
// config off the stored manifest's `providerConfig`, render the per-PR project name +
// `{{var}}` templates, REWRITE the repo's compose file into a single isolation-safe project
// (every published host port forced ephemeral so concurrent per-PR stacks never collide, the
// probed service guaranteed to publish its port, and references this checkout-free backend
// cannot honor — build contexts / host bind mounts / relative env_files / privileged services —
// rejected up front), and parse the `docker compose port` / `ps` output. No I/O — the provider
// does the daemon calls through an injected `ComposeRuntime`.
//
// This backend rides the contract's generic environment-backend manifest member (no typed
// variant, no migration): everything non-secret lives in `manifest.providerConfig`, written
// by the SPA's descriptor-driven connect form (`describeConfig`/`describeManifestTemplate`).

/** A single `docker compose` invocation result (exit code + captured output). */
export interface ComposeExecResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * The host seam the provider drives. A facade (local mode) implements it over the docker CLI
 * + a host temp dir; the integrations package stays free of `node:*` so it remains
 * runtime-neutral. `compose(args)` runs `docker compose <args>`; `writeProjectFile` persists a
 * scratch file (the repo's compose file + the generated override) somewhere the daemon reads.
 */
export interface ComposeRuntime {
  /**
   * Run `docker compose <args>`; resolves with the exit code + captured stdout/stderr. `timeoutMs`
   * bounds the invocation (a wedged daemon must not hang provision/status/teardown forever); the
   * facade kills the child + surfaces a non-zero result when it elapses.
   */
  compose(
    args: string[],
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ComposeExecResult>
  /** Write a per-project scratch file; returns its absolute host path. */
  writeProjectFile(project: string, fileName: string, content: string): Promise<string>
  /** Best-effort removal of a project's scratch dir after teardown. Optional. */
  cleanupProject?(project: string): Promise<void>
  /**
   * Build-from-source mode only: shallow-clone the PR repo into a per-project working tree so
   * `build:` contexts / in-checkout bind mounts / relative `env_file`s resolve, and return the
   * checkout's absolute host path. Optional — a runtime that can't clone (no daemon / the
   * conformance fake) omits it, and the provider fails build mode deterministically.
   */
  checkout?(
    project: string,
    target: { cloneUrl: string; ref: string; token?: string },
  ): Promise<{ dir: string }>
  /**
   * Build-from-source mode only: write the rewritten compose file INTO the checkout (beside the
   * original, so relative paths still resolve) at `relPath` under the project's checkout dir;
   * returns its absolute host path. Optional, paired with {@link checkout}.
   */
  writeCheckoutFile?(project: string, relPath: string, content: string): Promise<string>
}

/** The flat per-workspace config, read off `manifest.providerConfig`. */
export interface ComposeEnvironmentConfig {
  label: string
  /** Path to the compose file (co-located in the PR repo by default). */
  composePath: string
  /** Read the compose file from a SEPARATE `owner/repo` instead of the PR repo. */
  composeRepo?: string
  /** Ref to read the separate repo at; absent ⇒ that repo's default branch. */
  composeRef?: string
  /** The compose service whose port is published + probed for the preview URL. */
  service: string
  /** The in-container port to publish + probe. */
  port: number
  /** URL scheme (default `http`). */
  scheme?: 'http' | 'https'
  /** Project-name template (default derived from repo + PR number / block id). */
  projectTemplate?: string
  /** Optional image ref made available to the compose file as `{{image}}`. */
  imageTemplate?: string
  /** Optional extra env passed to compose (templated), for `${VAR}` interpolation. */
  envTemplate?: Record<string, string>
  /** Fallback TTL (ms) after which the env is swept + torn down. */
  defaultTtlMs?: number
  /**
   * Build-from-source mode: clone the PR head into a working tree and `docker compose build`
   * the stack's images from its Dockerfiles instead of pulling pre-built images. Unlocks
   * `build:`, in-checkout bind mounts, and relative `env_file`s (still refuses `privileged`
   * and host-escaping mounts). Absent/false ⇒ the checkout-free image-pull path (v1).
   */
  build?: boolean
  /** Build-mode only: bound (ms) for `docker compose build`, separate from the `up --wait` bound. */
  buildTimeoutMs?: number
}

const DEFAULT_COMPOSE_PATH = 'docker-compose.yml'

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Coerce a config value to a boolean. The descriptor-driven connect form writes booleans as the
 * strings `'true'`/`'false'` (the generic overlay stringifies everything), so accept both a real
 * boolean and the string forms; anything else ⇒ false.
 */
function optionalBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

/**
 * Read the flat Compose config off the stored manifest's `providerConfig`. Validates the two
 * load-bearing fields (service + port); throws a clear error otherwise. The connect form wrote
 * these as strings (the generic descriptor overlay), so `port` is coerced from its string form.
 */
export function parseComposeEnvConfig(manifest: EnvironmentManifest): ComposeEnvironmentConfig {
  const raw = (manifest.providerConfig ?? {}) as Record<string, unknown>
  const service = optionalString(raw.service)
  if (!service) {
    throw new Error('Docker Compose environment is missing the web service name (service)')
  }
  const port = Number(raw.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Docker Compose environment has an invalid container port: ${String(raw.port)}`)
  }
  const scheme = raw.scheme === 'https' ? 'https' : 'http'
  const envTemplate =
    raw.envTemplate && typeof raw.envTemplate === 'object'
      ? Object.fromEntries(
          Object.entries(raw.envTemplate as Record<string, unknown>).map(([k, val]) => [
            k,
            String(val),
          ]),
        )
      : undefined
  return {
    label: manifest.label,
    composePath: optionalString(raw.composePath) ?? DEFAULT_COMPOSE_PATH,
    composeRepo: optionalString(raw.composeRepo),
    composeRef: optionalString(raw.composeRef),
    service,
    port,
    scheme,
    projectTemplate: optionalString(raw.projectTemplate),
    imageTemplate: optionalString(raw.imageTemplate),
    envTemplate,
    defaultTtlMs: resolveTtlMs(raw.ttlMinutes, manifest.defaultTtlMs),
    build: optionalBoolean(raw.build),
    buildTimeoutMs: resolveBuildTimeoutMs(raw.buildTimeoutMinutes),
  }
}

/**
 * Resolve the build-mode `docker compose build` timeout (ms) from the connect form's
 * `buildTimeoutMinutes` (a string). A blank/invalid/non-positive value ⇒ undefined (the provider
 * falls back to its default build bound).
 */
function resolveBuildTimeoutMs(rawBuildTimeoutMinutes: unknown): number | undefined {
  const minutes = Number(optionalString(rawBuildTimeoutMinutes))
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : undefined
}

/**
 * Resolve the env's auto-teardown TTL (ms). The connect form collects it as `ttlMinutes` (a
 * string) so a leaked compose project is swept off the host instead of running forever; a present
 * `0`/blank/invalid value is an explicit "never expire" (undefined), and an absent field falls
 * back to the manifest's own `defaultTtlMs`.
 */
function resolveTtlMs(
  rawTtlMinutes: unknown,
  manifestDefaultTtlMs: number | undefined,
): number | undefined {
  const ttlMinutes = optionalString(rawTtlMinutes)
  if (ttlMinutes === undefined) return manifestDefaultTtlMs
  const minutes = Number(ttlMinutes)
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : undefined
}

/** Build the stored manifest that carries a Compose env config in its `providerConfig`. */
export function composeConfigToManifest(config: ComposeEnvironmentConfig): EnvironmentManifest {
  return {
    providerId: 'compose',
    label: config.label,
    // Inert: the provider always returns a localhost URL, so baseUrl is never fetched and is
    // not SSRF-checked. A placeholder keeps the manifest schema (which requires a non-empty
    // baseUrl + provision + response) satisfied.
    baseUrl: 'http://localhost',
    auth: { type: 'none' },
    provision: { method: 'POST', pathTemplate: '' },
    response: {},
    ...(config.defaultTtlMs ? { defaultTtlMs: config.defaultTtlMs } : {}),
    providerConfig: { ...config } as unknown as Record<string, unknown>,
  }
}

/** Replace `{{ key }}` placeholders from `vars`; an unknown key resolves to ''. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '')
}

/** Render every value of an env map through {@link renderTemplate}. */
export function renderEnvMap(
  env: Record<string, string>,
  vars: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, val]) => [k, renderTemplate(val, vars)]))
}

/**
 * Sanitize an arbitrary string into a valid Docker Compose project name: lower-case, only
 * `[a-z0-9_-]`, must start with `[a-z0-9]`, bounded length. Mirrors the k8s namespace
 * sanitize so two stacks can't collide on a malformed name.
 */
export function sanitizeProjectName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/g, '')
    .slice(0, 63)
  return cleaned.length > 0 ? cleaned : 'cf-env'
}

/** A short, stable, filesystem-safe digest (djb2 → base36) used to disambiguate project names. */
export function shortHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6)
}

/**
 * Resolve the per-PR project name. An explicit `projectTemplate` is rendered + sanitized; else
 * the default qualifies the PR number with the repo (a workspace can have many repos that each
 * open a PR with the SAME number — a bare `cf-env-<pr>` would collide on one project and the
 * second PR's `up`/`down` would hit the first's stack) AND, when known, a short digest of the
 * globally-unique block id (so two DIFFERENT workspaces sharing a repo name + PR number on the
 * same host can't collide either). It falls back to the block id, then a bare PR number, for a
 * manual provision.
 */
export function resolveProjectName(
  config: ComposeEnvironmentConfig,
  inputs: Record<string, string>,
): string {
  if (config.projectTemplate) {
    return sanitizeProjectName(renderTemplate(config.projectTemplate, inputs))
  }
  if (inputs.repoName && inputs.pullNumber) {
    const base = `cf-env-${inputs.repoName}-${inputs.pullNumber}`
    return sanitizeProjectName(inputs.blockId ? `${base}-${shortHash(inputs.blockId)}` : base)
  }
  return sanitizeProjectName(`cf-env-${inputs.blockId || inputs.pullNumber || 'env'}`)
}

/** The `{{var}}` substitution map available to the compose text + env templates. */
export function templateVars(
  inputs: Record<string, string>,
  project: string,
  image: string | undefined,
): Record<string, string> {
  return { ...inputs, project, ...(image !== undefined ? { image } : {}) }
}

type ComposeDoc = Record<string, unknown>
type ComposeService = Record<string, unknown>

function servicesOf(doc: ComposeDoc): Record<string, ComposeService> {
  const services = doc.services
  if (!services || typeof services !== 'object') return {}
  return services as Record<string, ComposeService>
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

/** The container-target of a normalized (host-stripped) short-form ports entry: `"8080/tcp"` → `8080`. */
function portTarget(entry: string): string {
  return (entry.split('/')[0] ?? '').trim()
}

/**
 * Rewrite a single `ports` entry to its container-only (ephemeral host port) form, dropping any
 * host ip / published host port. `"127.0.0.1:8080:8080"` / `"8080:8080"` / `{ published, target }`
 * all collapse to `"8080"`; a protocol suffix is preserved. Returns null for an unparsable entry.
 */
export function toEphemeralPortEntry(entry: unknown): string | null {
  if (typeof entry === 'number') return String(entry)
  if (typeof entry === 'string') {
    const [mapping, proto] = entry.split('/')
    const segments = (mapping ?? '').split(':')
    const target = segments[segments.length - 1]?.trim()
    if (!target) return null
    return proto ? `${target}/${proto}` : target
  }
  if (entry && typeof entry === 'object') {
    const e = entry as Record<string, unknown>
    if (e.target === undefined || e.target === null) return null
    const proto = typeof e.protocol === 'string' ? e.protocol : undefined
    return proto ? `${String(e.target)}/${proto}` : String(e.target)
  }
  return null
}

/**
 * Force every service's published host ports to ephemeral. Compose MERGES (`-f` overlays) and
 * a base compose file usually pins the web service's host port (`"8080:8080"`) — leaving that in
 * place makes concurrent per-PR stacks collide on one host port, defeating the project-name
 * isolation. So instead of an additive override we rewrite the file: each service's host port is
 * stripped, leaving the container port published to an ephemeral host port. Mutates + returns the doc.
 */
export function neutralizeHostPorts(doc: ComposeDoc): ComposeDoc {
  for (const service of Object.values(servicesOf(doc))) {
    if (!service || typeof service !== 'object' || !Array.isArray(service.ports)) continue
    service.ports = service.ports.map(toEphemeralPortEntry).filter((p): p is string => p !== null)
  }
  return doc
}

/** Guarantee the probed service publishes `port`, so `docker compose port` can read the host binding back. */
export function ensureServicePublishes(doc: ComposeDoc, service: string, port: number): ComposeDoc {
  const svc = servicesOf(doc)[service]
  if (!svc || typeof svc !== 'object') return doc
  const ports = Array.isArray(svc.ports) ? (svc.ports as unknown[]).map(String) : []
  svc.ports = ports.some((p) => portTarget(p) === String(port)) ? ports : [...ports, String(port)]
  return doc
}

function isRelativePath(path: string): boolean {
  return !path.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(path)
}

/** True when a service declares a `build:` (a build context / long-form build object). */
export function hasBuildDirective(service: unknown): boolean {
  return !!service && typeof service === 'object' && (service as ComposeService).build !== undefined
}

/**
 * True when a bind-mount source would resolve OUTSIDE the cloned checkout — an absolute path, a
 * `~` home ref, a Windows drive path, or a relative path whose normalized form pops above the
 * checkout root (`../` escape). These stay refused even in build mode (host-filesystem escape);
 * only in-checkout relatives (`./x`, `x`, `x/y`) are allowed. A named/anonymous volume is never a
 * bind source (callers only pass the result of {@link bindMountSource}, which is already null for
 * those), so this only ever judges a real host-path source.
 */
export function escapesCheckout(source: string): boolean {
  if (source.startsWith('/') || source.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(source))
    return true
  let depth = 0
  for (const segment of source.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      depth -= 1
      if (depth < 0) return true // escaped above the checkout root
    } else {
      depth += 1
    }
  }
  return false
}

export function bindMountSource(volume: unknown): string | null {
  if (typeof volume === 'string') {
    const segments = volume.split(':')
    if (segments.length < 2) return null // anonymous volume (`/data`) — a container path, not a host bind
    const source = segments[0] ?? ''
    return source.startsWith('.') || source.startsWith('/') || source.startsWith('~')
      ? source
      : null
  }
  if (volume && typeof volume === 'object') {
    const v = volume as Record<string, unknown>
    if (v.type === 'bind') return typeof v.source === 'string' ? v.source : 'bind'
    if (v.type === undefined && typeof v.source === 'string') {
      const s = v.source
      return s.startsWith('.') || s.startsWith('/') || s.startsWith('~') ? s : null
    }
  }
  return null
}

/**
 * Collect references this backend cannot honor or must refuse, so a provision fails fast with a
 * clear reason instead of silently mis-mounting / over-privileging. The stack runs on the
 * operator's shared host daemon, so host access is a safety concern in BOTH modes.
 *
 * **Image mode** (`opts.build` absent/false — the checkout-free default): the compose file is read
 * with no repo on disk, so anything resolved against the repo working tree is broken —
 *  - `build:` — needs the source tree (image-based stacks only);
 *  - ANY host bind mount — resolves against an empty scratch dir; also exposes the host filesystem;
 *  - relative `env_file` — points into the absent repo tree;
 *  - `privileged: true` — refused on the shared host daemon.
 *
 * **Build mode** (`opts.build === true`): the PR head is cloned into a working tree, so `build:`
 * contexts, IN-CHECKOUT relative bind mounts, and relative `env_file`s all resolve and are allowed.
 * Still refused, because they escape the checkout or the daemon's safety envelope —
 *  - a host-escaping bind source (absolute / `~` / `../` above the checkout root, per
 *    {@link escapesCheckout});
 *  - `privileged: true` (unchanged).
 */
export function collectUnsupportedComposeRefs(
  doc: ComposeDoc,
  opts?: { build?: boolean },
): string[] {
  const build = opts?.build === true
  const issues: string[] = []
  for (const [name, service] of Object.entries(servicesOf(doc))) {
    if (!service || typeof service !== 'object') continue
    if (!build && service.build !== undefined) {
      issues.push(
        `service '${name}' uses build: — image-based stacks only (no repo is checked out)`,
      )
    }
    if (service.privileged === true) {
      issues.push(`service '${name}' requests privileged: true — refused on the shared host daemon`)
    }
    for (const volume of asArray(service.volumes)) {
      const source = bindMountSource(volume)
      if (source === null) continue
      if (!build) {
        issues.push(
          `service '${name}' bind-mounts a host path ('${source}') — unsupported (no repo on disk; use a named volume)`,
        )
      } else if (escapesCheckout(source)) {
        issues.push(
          `service '${name}' bind-mounts a path outside the checkout ('${source}') — refused (host-filesystem escape)`,
        )
      }
    }
    if (!build) {
      for (const entry of asArray(service.env_file)) {
        const path =
          typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.path
        if (typeof path === 'string' && isRelativePath(path)) {
          issues.push(
            `service '${name}' reads a relative env_file ('${path}') — unsupported (no repo on disk)`,
          )
        }
      }
    }
  }
  return issues
}

/** The outcome of preparing a repo compose file into a single isolation-safe project file. */
export interface PreparedCompose {
  /** The rewritten compose file to hand to `docker compose -f` (valid even when `issues` is non-empty). */
  content: string
  /** Blocking reasons the stack can't be provisioned as-is; non-empty ⇒ the provider fails the provision. */
  issues: string[]
}

/**
 * Turn the (already `{{var}}`-rendered) repo compose text into ONE isolation-safe project file:
 * validate it parses + contains the probed service, surface any unsupported references, force all
 * host ports ephemeral, and guarantee the probed service publishes its port. Returning a single
 * rewritten file (rather than a second `-f` overlay) is what lets us STRIP the base's pinned host
 * ports — an overlay can only add, not remove.
 */
export function prepareComposeProject(
  renderedText: string,
  service: string,
  port: number,
  opts?: { build?: boolean },
): PreparedCompose {
  let parsed: unknown
  try {
    parsed = parse(renderedText)
  } catch (err) {
    return {
      content: renderedText,
      issues: [
        `compose file is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { content: renderedText, issues: ['compose file is empty or not a mapping'] }
  }
  const doc = parsed as ComposeDoc
  if (!servicesOf(doc)[service]) {
    return { content: renderedText, issues: [`compose file has no service named '${service}'`] }
  }
  const issues = collectUnsupportedComposeRefs(doc, opts)
  // Isolation applies in BOTH modes: force host ports ephemeral so concurrent per-PR stacks never
  // collide, and guarantee the probed service publishes its port for `docker compose port`.
  neutralizeHostPorts(doc)
  ensureServicePublishes(doc, service, port)
  return { content: stringify(doc), issues }
}

/**
 * Parse the host port out of `docker compose port <svc> <port>` output (e.g. `0.0.0.0:49153`
 * or `[::]:49153`). Returns null when the service publishes no host port for that target.
 */
export function parseHostPort(output: string): number | null {
  const line = output
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .pop()
  if (!line) return null
  const match = line.match(/:(\d+)\s*$/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

interface ComposePsRow {
  State?: string
  Health?: string
  ExitCode?: number
}

/** Parse `docker compose ps --format json` (a JSON array OR newline-delimited objects). */
export function parseComposePsRows(output: string): ComposePsRow[] {
  const trimmed = output.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed as ComposePsRow[]
    return [parsed as ComposePsRow]
  } catch {
    // Newline-delimited JSON objects (older compose).
    const rows: ComposePsRow[] = []
    for (const line of trimmed.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try {
        rows.push(JSON.parse(s) as ComposePsRow)
      } catch {
        // ignore an unparsable line
      }
    }
    return rows
  }
}

/**
 * Reduce a `docker compose ps -a` snapshot (the `-a` includes stopped containers) into one
 * lifecycle verdict:
 *  - empty ⇒ `failed` (the project is gone / never came up);
 *  - any `unhealthy` service, or a container `exited`/`dead` with a non-zero code ⇒ `failed`;
 *  - a transient state (`created`/`restarting`/`paused`/`removing`) or a `running` service still
 *    `starting` its healthcheck ⇒ `provisioning` (so a brief recreate doesn't flip a healthy env
 *    to `failed`);
 *  - a clean one-shot that `exited (0)` is treated as complete (neither pending nor failing);
 *  - otherwise ⇒ `ready`.
 */
export function classifyComposePs(output: string): EnvironmentStatus {
  const rows = parseComposePsRows(output)
  if (rows.length === 0) return 'failed' // nothing left ⇒ the stack is gone/crashed
  let anyPending = false
  for (const row of rows) {
    const state = (row.State ?? '').toLowerCase()
    const health = (row.Health ?? '').toLowerCase()
    if (health === 'unhealthy') return 'failed'
    if (state.startsWith('running')) {
      if (health === 'starting') anyPending = true
    } else if (state.startsWith('exited') || state.startsWith('dead')) {
      if ((row.ExitCode ?? 0) !== 0) return 'failed' // a real crash
      // exit 0 ⇒ a completed one-shot (migration/seed); not pending, not a failure
    } else {
      // created / restarting / paused / removing / … ⇒ still settling
      anyPending = true
    }
  }
  return anyPending ? 'provisioning' : 'ready'
}

/**
 * The POSIX directory portion of a repo-relative compose path (`''` for a root-level file):
 * `docker-compose.yml` → `''`, `deploy/docker-compose.yml` → `deploy`. Pure string work (no
 * `node:path`, so the integrations package stays runtime-neutral). Build mode writes the rewritten
 * compose here (beside the original inside the checkout) and passes `<checkout>/<dir>` as
 * `--project-directory`, so relative build contexts / bind mounts / env_files resolve as authored.
 */
export function composeFileDir(composePath: string): string {
  const normalized = composePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const idx = normalized.lastIndexOf('/')
  return idx <= 0 ? '' : normalized.slice(0, idx)
}

/** A short tail of command output, for a deterministic-failure `lastError`. */
export function tailOutput(output: string, lines = 12): string {
  return output
    .split('\n')
    .map((s) => s.trimEnd())
    .filter(Boolean)
    .slice(-lines)
    .join('\n')
}
