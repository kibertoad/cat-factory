import type { EnvironmentManifest, EnvironmentStatus } from '@cat-factory/kernel'
import { stringify } from 'yaml'

// Pure helpers for the Docker Compose ENVIRONMENT backend: read the flat per-workspace
// config off the stored manifest's `providerConfig`, render the per-PR project name +
// `{{var}}` templates, build the publish override that exposes the web service's port on
// an ephemeral host port, and parse the `docker compose port` / `ps` output. No I/O — the
// provider does the daemon calls through an injected `ComposeRuntime`.
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
  /** Run `docker compose <args>`; resolves with the exit code + captured stdout/stderr. */
  compose(args: string[], opts?: { env?: Record<string, string> }): Promise<ComposeExecResult>
  /** Write a per-project scratch file; returns its absolute host path. */
  writeProjectFile(project: string, fileName: string, content: string): Promise<string>
  /** Best-effort removal of a project's scratch dir after teardown. Optional. */
  cleanupProject?(project: string): Promise<void>
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
}

const DEFAULT_COMPOSE_PATH = 'docker-compose.yml'

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
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
    defaultTtlMs: manifest.defaultTtlMs,
  }
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

/**
 * Resolve the per-PR project name. An explicit `projectTemplate` is rendered + sanitized; else
 * the default qualifies the PR number with the repo (a workspace can have many repos that each
 * open a PR with the SAME number — a bare `cf-env-<pr>` would collide on one project and the
 * second PR's `up`/`down` would hit the first's stack), falling back to the globally-unique
 * block id, then a bare PR number for a manual provision.
 */
export function resolveProjectName(
  config: ComposeEnvironmentConfig,
  inputs: Record<string, string>,
): string {
  if (config.projectTemplate) {
    return sanitizeProjectName(renderTemplate(config.projectTemplate, inputs))
  }
  const suffix =
    inputs.repoName && inputs.pullNumber
      ? `${inputs.repoName}-${inputs.pullNumber}`
      : inputs.blockId || inputs.pullNumber || 'env'
  return sanitizeProjectName(`cf-env-${suffix}`)
}

/** The `{{var}}` substitution map available to the compose text + env templates. */
export function templateVars(
  inputs: Record<string, string>,
  project: string,
  image: string | undefined,
): Record<string, string> {
  return { ...inputs, project, ...(image !== undefined ? { image } : {}) }
}

/**
 * Build the generated compose override that publishes the web service's container port to an
 * ephemeral host port (a single-element `ports` mapping with only the target port). This is the
 * Checkbox CI-overlay mechanic: per-run isolation comes from the project name, and the host
 * port is left ephemeral so concurrent stacks never collide. `docker compose port` reads the
 * assignment back.
 */
export function buildPublishOverride(service: string, port: number): string {
  return stringify({ services: { [service]: { ports: [`${port}`] } } })
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

/** Reduce a `docker compose ps` snapshot into one lifecycle verdict. */
export function classifyComposePs(output: string): EnvironmentStatus {
  const rows = parseComposePsRows(output)
  if (rows.length === 0) return 'failed' // nothing running ⇒ the stack is gone/crashed
  let anyPending = false
  for (const row of rows) {
    const state = (row.State ?? '').toLowerCase()
    const health = (row.Health ?? '').toLowerCase()
    if (health === 'unhealthy') return 'failed'
    if (state !== 'running') anyPending = true
    else if (health === 'starting') anyPending = true
  }
  return anyPending ? 'provisioning' : 'ready'
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
