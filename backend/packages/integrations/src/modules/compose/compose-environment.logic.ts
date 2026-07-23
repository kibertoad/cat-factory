import type {
  EnvironmentManifest,
  EnvironmentStatus,
  RecipeHealthGate,
  RecipeStep,
  StackRecipe,
} from '@cat-factory/kernel'
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
    opts?: {
      env?: Record<string, string>
      timeoutMs?: number
      /**
       * STACK-RECIPE `compose-exec` step only: stream a repo-relative file from the project's
       * checkout into the command's stdin (a `.sql` seed dump piped to a db client). The runtime
       * resolves `checkoutFile` under the project's checkout dir and pipes it as stdin. Requires a
       * checkout (build/recipe mode); ignored by a runtime that can't clone.
       */
      stdin?: { project: string; checkoutFile: string }
    },
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
  /**
   * STACK-RECIPE mode only: copy a committed template to its gitignored target INSIDE the checkout
   * (env-file materialization + `copy-file` steps — `.env.dev.local-dist` → `.env.dev.local`). Both
   * paths are repo-relative and have already passed the checkout-escape guard. Optional, paired
   * with {@link checkout}.
   */
  copyCheckoutFile?(project: string, from: string, to: string): Promise<void>
  /**
   * STACK-RECIPE `wait-file` step only (checkout target): whether a repo-relative path exists in
   * the checkout (the frontend build's `manifest.json` gate, when it lands in the working tree
   * rather than a container). A `wait-file` targeting a running container polls via
   * `docker compose exec … test -f` instead. Optional, paired with {@link checkout}.
   */
  checkoutFileExists?(project: string, relPath: string): Promise<boolean>
  /**
   * STACK-RECIPE `host-command` step only: run an arbitrary argv on the ORCHESTRATOR HOST (not in
   * a container) with `cwd` at the checkout (+ optional `workdir` under it). The single trust-
   * boundary-widening step kind — gated behind the recipe's own opt-in and refused unless the
   * runtime supports it (local facade only). Optional; absent ⇒ `host-command` steps are refused.
   */
  hostCommand?(
    project: string,
    argv: string[],
    opts?: { workdir?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<ComposeExecResult>
  /**
   * SHARED-STACK bring-up only: idempotently ensure a named Docker network exists (`docker network
   * inspect <name> || docker network create <name>`), so a shared stack can create + own the
   * external networks its consumers attach to (the acme `acme-net` shape). Not a compose subcommand,
   * so it is its own seam. Optional; absent ⇒ a shared stack that declares managed networks fails
   * loudly (no host daemon).
   */
  ensureNetwork?(name: string): Promise<ComposeExecResult>
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
  /**
   * The declarative STACK RECIPE for a complex multi-step bring-up — multi-`-f` layering,
   * `COMPOSE_PROFILES`, env-file materialization, ordered setup/teardown steps + a terminal health
   * gate. Merged from the SERVICE's provisioning into `providerConfig.recipe` at resolve time
   * (`handlerConfigToBackendConfig`); absent ⇒ the simple single-file `composePath` + `up --wait`
   * path. When present, `recipe.composeFiles` supersedes `composePath`, and a recipe always
   * materializes a checkout (its steps + env files operate on the working tree).
   */
  recipe?: StackRecipe
  /**
   * Opt-in to a recipe's `host-command` steps — the ONE trust-boundary-widening step kind (it
   * runs an arbitrary argv on the orchestrator host, not in a container). Off by default; a recipe
   * `host-command` step is refused unless the WORKSPACE handler sets this (the operator owns the
   * host, so the opt-in is theirs, like the `build` flag) AND the runtime supports host commands.
   */
  allowHostCommands?: boolean
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
    allowHostCommands: optionalBoolean(raw.allowHostCommands),
    ...(isStackRecipe(raw.recipe) ? { recipe: raw.recipe } : {}),
  }
}

/**
 * A structural guard for the persisted `providerConfig.recipe`. The recipe was validated by
 * `serviceProvisioningSchema` when the service block's provisioning was saved and merged in verbatim
 * (`handlerConfigToBackendConfig`), so this is a defensive shape check — a plain object — not a
 * re-validation; a non-object (a stale/hand-edited config) is treated as "no recipe".
 */
function isStackRecipe(value: unknown): value is StackRecipe {
  return !!value && typeof value === 'object' && !Array.isArray(value)
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

/** True when a service declares a `build:` (a build context / long-form build object). */
export function hasBuildDirective(service: unknown): boolean {
  return !!service && typeof service === 'object' && (service as ComposeService).build !== undefined
}

/**
 * The external networks a compose doc expects to ALREADY exist — a top-level `networks:` entry
 * flagged `external: true` (or `external: { name }`). Returns each network's RESOLVED name (the
 * explicit `name:` on the network def, else the `name:` inside an `external` object, else the map
 * key), deduped in declaration order. These are created + owned OUTSIDE the per-PR project (by a
 * SharedStack or the engine — the acme `acme-net` shape): detection recommends them onto
 * `recipe.externalNetworks`, and the compose provider (slice 5) attaches the per-PR project to them
 * as `external: true`. Pure — no I/O.
 */
export function extractExternalNetworks(doc: ComposeDoc): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const net of topLevelNetworks(doc)) {
    if (!net.external || seen.has(net.resolvedName)) continue
    seen.add(net.resolvedName)
    names.push(net.resolvedName)
  }
  return names
}

/** One top-level `networks:` entry, with its RESOLVED Docker name and whether it is external. */
interface TopLevelNetwork {
  key: string
  resolvedName: string
  external: boolean
}

/**
 * Parse a compose doc's top-level `networks:` map into {@link TopLevelNetwork} entries. A network is
 * external when flagged `external: true` or `external: { name }` (it must ALREADY exist); anything
 * else — a driver/labels def, a bare `netname:` (null/scalar def), `external: false` — is
 * project-owned (compose creates it). The RESOLVED name is the explicit `name:`, else an
 * `external.name`, else the map key. A malformed `networks:` (array / scalar) yields no entries.
 * Pure — no I/O.
 */
function topLevelNetworks(doc: ComposeDoc): TopLevelNetwork[] {
  const networks = doc.networks
  if (!networks || typeof networks !== 'object' || Array.isArray(networks)) return []
  const out: TopLevelNetwork[] = []
  for (const [key, def] of Object.entries(networks as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') {
      // A bare `netname:` (null/scalar def) is a project-owned network with default settings.
      out.push({ key, resolvedName: key, external: false })
      continue
    }
    const d = def as Record<string, unknown>
    const external = d.external
    // An array (or other non-plain-object) `external` value is malformed and does NOT mark it external.
    const externalObject =
      external !== null && typeof external === 'object' && !Array.isArray(external)
        ? (external as Record<string, unknown>)
        : undefined
    const externalName = externalObject ? optionalString(externalObject.name) : undefined
    out.push({
      key,
      resolvedName: optionalString(d.name) ?? externalName ?? key,
      external: external === true || externalObject !== undefined,
    })
  }
  return out
}

/**
 * Attach a recipe's LAYERED compose docs (the `-f` layers, which compose merges at `up`) to a set of
 * EXTERNAL Docker networks a SharedStack owns (the acme `acme-net` shape, slice 5). For each requested
 * network not already declared external across the merged layers, declare it top-level `{ external:
 * true }` (on the base layer — compose merges top-level `networks:` maps across files) so compose
 * attaches to the REAL pre-existing network instead of a project-scoped `<project>_<name>`, and join
 * it from every service not pinned to `network_mode`.
 *
 * Every decision is made against the MERGED stack, never a single layer in isolation, because compose
 * unions the layers — a naive per-layer rewrite fights that merge:
 * - a service is attached in EXACTLY ONE layer, so `default` is added at most once and ONLY when no
 *   layer declares an explicit `networks` for it (an override that omits `networks` INHERITS the base's
 *   scoping — it is not "on default", so re-adding `default` would silently reconnect a service the
 *   base deliberately isolated);
 * - a service pinned to `network_mode` in ANY layer is skipped (compose rejects `network_mode` +
 *   `networks`, even when the two sit in different layers);
 * - a requested name colliding with a PROJECT-OWNED top-level network in any layer is returned as a
 *   blocking issue rather than silently overwriting the author's private network with `{ external: true }`.
 *
 * Mutates the docs; returns any blocking issues (empty on success). Pure — no I/O.
 */
export function attachExternalNetworks(docs: ComposeDoc[], networks: string[]): string[] {
  if (networks.length === 0 || docs.length === 0) return []
  const tops = docs.flatMap(topLevelNetworks)
  const externalNames = new Set(tops.filter((t) => t.external).map((t) => t.resolvedName))
  const requested = networks.filter((name) => !externalNames.has(name))
  if (requested.length === 0) return []

  // A requested network that collides with a project-owned network of the same resolved name is
  // ambiguous — converting it to external would cross-wire the per-PR services onto the shared segment
  // (and drop the author's driver/labels). Fail loud, like every other recipe issue.
  const projectOwned = new Set(tops.filter((t) => !t.external).map((t) => t.resolvedName))
  const collisions = requested.filter((name) => projectOwned.has(name))
  if (collisions.length > 0) {
    return collisions.map(
      (name) =>
        `network '${name}' is declared project-owned in the recipe's compose but is also a shared-stack/external network the recipe attaches — rename one so the per-PR project isn't silently cross-wired onto the shared network.`,
    )
  }

  for (const [name, plan] of planServiceAttach(docs)) {
    if (plan.hasNetworkMode) continue
    const service = servicesOf(docs[plan.targetLayer]!)[name]
    if (!service || typeof service !== 'object') continue
    attachServiceNetworks(service, requested, plan.hasExplicitNetworks)
  }

  // Declare the external networks once, top-level, on the base layer (compose merges the layers'
  // top-level `networks:` maps, so a single declaration covers the whole merged config).
  const base = docs[0]!
  const baseTop =
    base.networks && typeof base.networks === 'object' && !Array.isArray(base.networks)
      ? (base.networks as Record<string, unknown>)
      : {}
  for (const name of requested) baseTop[name] = { external: true }
  base.networks = baseTop
  return []
}

/** Where + how one service should join the external networks, decided across all `-f` layers. */
interface ServiceAttachPlan {
  /**
   * The layer to write the attachment into: the last layer that declares an explicit `networks` for
   * the service (so the new names land beside the author's existing ones), else the first layer that
   * defines it (the implicit-`default` case).
   */
  targetLayer: number
  hasNetworkMode: boolean
  hasExplicitNetworks: boolean
}

/**
 * Plan each service's external-network attachment against the MERGED stack: its first-defining layer,
 * whether ANY layer pins `network_mode`, and whether ANY layer declares an explicit `networks` (and,
 * if so, the last such layer — the write target that keeps the union beside the author's scoping).
 */
function planServiceAttach(docs: ComposeDoc[]): Map<string, ServiceAttachPlan> {
  const firstLayer = new Map<string, number>()
  const lastExplicitLayer = new Map<string, number>()
  const networkMode = new Set<string>()
  docs.forEach((doc, layer) => {
    for (const [name, service] of Object.entries(servicesOf(doc))) {
      if (!service || typeof service !== 'object') continue
      if (!firstLayer.has(name)) firstLayer.set(name, layer)
      if (service.network_mode !== undefined) networkMode.add(name)
      if (service.networks !== undefined && service.networks !== null) {
        lastExplicitLayer.set(name, layer)
      }
    }
  })
  const plans = new Map<string, ServiceAttachPlan>()
  for (const [name, first] of firstLayer) {
    const explicit = lastExplicitLayer.get(name)
    plans.set(name, {
      targetLayer: explicit ?? first,
      hasNetworkMode: networkMode.has(name),
      hasExplicitNetworks: explicit !== undefined,
    })
  }
  return plans
}

/**
 * Add `networks` to one service, preserving its existing connectivity. A service with no `networks`
 * key gets `['default', …]` ONLY when no layer scopes it explicitly (`hasExplicitNetworks` false) —
 * otherwise the explicit scoping lives in another layer and re-adding `default` would clobber it (via
 * compose's cross-`-f` union), so only the new names are added. An array unions in the new names; a
 * long-form map adds them as keys (default settings). The caller skips `network_mode`-pinned services.
 */
function attachServiceNetworks(
  service: ComposeService,
  networks: string[],
  hasExplicitNetworks: boolean,
): void {
  const existing = service.networks
  if (existing === undefined || existing === null) {
    service.networks = hasExplicitNetworks ? [...networks] : ['default', ...networks]
    return
  }
  if (Array.isArray(existing)) {
    const names = existing.map(String)
    for (const name of networks) if (!names.includes(name)) names.push(name)
    service.networks = names
    return
  }
  if (typeof existing === 'object') {
    const map = existing as Record<string, unknown>
    for (const name of networks) if (!(name in map)) map[name] = null
  }
  // Any other (malformed) `networks` value is left as-is rather than clobbered.
}

/**
 * The union of every `profiles:` label declared across the doc's services, deduped + sorted.
 * Compose profiles gate optional service groups (`COMPOSE_PROFILES`); detection surfaces them
 * default-OFF as opt-in candidates rather than enabling them. Pure — no I/O.
 */
export function extractComposeProfiles(doc: ComposeDoc): string[] {
  const labels = new Set<string>()
  for (const service of Object.values(servicesOf(doc))) {
    if (!service || typeof service !== 'object') continue
    for (const raw of asArray((service as ComposeService).profiles)) {
      const label = optionalString(raw)
      if (label) labels.add(label)
    }
  }
  return [...labels].sort()
}

/**
 * True when a host path (bind source / env_file / build context / secret-or-config `file:`) would
 * resolve OUTSIDE the cloned checkout — so it stays refused even in build mode (host-filesystem
 * escape); only in-checkout relatives (`./x`, `x`, `x/y`) are allowed. Refused:
 *  - an absolute path (`/etc`), a `~` home ref, a Windows drive path (`C:\`), or a UNC / backslash
 *    root (`\\server\share`);
 *  - a relative path whose normalized form pops above the checkout root (`../` escape, including
 *    a mid-path `a/../../b`);
 *  - a path carrying an unresolved `$VAR`/`${VAR}` interpolation — the daemon expands it from the
 *    operator's environment before mounting, so it can become ANY host path; we can't bound it
 *    statically, so we refuse it rather than let it slip past.
 *
 * Relatives resolve against `--project-directory` (the compose file's own dir), which sits
 * `baseDepth` levels BELOW the checkout root, so `baseDepth` `../`s are still in-checkout (they
 * only reach the root) — a compose at `deploy/` may legitimately reference `..` (the repo root).
 * The escape line is the checkout root, not the compose dir. `baseDepth` defaults to 0 (root-level
 * compose file), which is the strictest.
 */
export function escapesCheckout(source: string, baseDepth = 0): boolean {
  if (
    source.startsWith('/') ||
    source.startsWith('~') ||
    source.startsWith('\\') || // UNC (\\server\share) / backslash-absolute
    /^[a-zA-Z]:[\\/]/.test(source) || // Windows drive path
    source.includes('$') // unresolved ${VAR}/$VAR — expands to an arbitrary host path at runtime
  )
    return true
  let depth = baseDepth
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

/** The number of path levels a repo-relative compose file sits below the checkout root — i.e. how
 * many `../`s a reference beside it may climb while staying in-checkout. `''`/root → 0. */
export function checkoutDepthFor(composePath: string): number {
  const dir = composeFileDir(composePath)
  return dir ? dir.split('/').length : 0
}

/**
 * The host-path source of a bind mount (short `src:dst[:mode]` or long `{ type: bind, source }`),
 * or null when the volume is a named/anonymous volume (never a host bind). A named volume name is
 * `[a-zA-Z0-9][a-zA-Z0-9_.-]*` — it can't contain a path separator — so ANY short-form source that
 * contains a `/` or `\` (or the usual `.`/`/`/`~` prefixes) is a host path and is returned for
 * {@link escapesCheckout} to judge. This is what stops a separator-buried escape like
 * `sub/../../../etc:/host` from being mis-read as a harmless named volume.
 */
export function bindMountSource(volume: unknown): string | null {
  if (typeof volume === 'string') {
    const segments = volume.split(':')
    if (segments.length < 2) return null // anonymous volume (`/data`) — a container path, not a host bind
    const source = segments[0] ?? ''
    return isHostPathSource(source) ? source : null
  }
  if (volume && typeof volume === 'object') {
    const v = volume as Record<string, unknown>
    if (v.type === 'bind') return typeof v.source === 'string' ? v.source : 'bind'
    if (v.type === undefined && typeof v.source === 'string') {
      const s = v.source
      return isHostPathSource(s) ? s : null
    }
  }
  return null
}

/** A short-form volume source is a host path (bind) — not a named volume — when it is prefixed
 * like a path or contains a path separator (a named volume name never does). */
function isHostPathSource(source: string): boolean {
  return (
    source.startsWith('.') ||
    source.startsWith('/') ||
    source.startsWith('~') ||
    source.includes('/') ||
    source.includes('\\')
  )
}

/** The build context of a service's `build:` (short string form or long `{ context }`), or null
 * when no `build:` is declared. A `build:` with no explicit context defaults to `.`. */
export function buildContextSource(build: unknown): string | null {
  if (build === undefined) return null
  if (typeof build === 'string') return build || '.'
  if (build && typeof build === 'object') {
    const ctx = (build as Record<string, unknown>).context
    return typeof ctx === 'string' ? ctx : '.'
  }
  return '.'
}

/**
 * Collect the unsupported / host-escape issues a single compose `service` raises: cross-file
 * `extends.file`, a `build:` context, `privileged: true`, bind mounts, and `env_file`s.
 * `refuseHostPath` encodes the mode's host-path policy (identical to the caller's).
 */
function collectServiceComposeIssues(
  name: string,
  service: ComposeService,
  build: boolean,
  baseDepth: number,
  refuseHostPath: (source: string) => boolean,
): string[] {
  const issues: string[] = []
  // Cross-file `extends: { file }` merges another file from disk — same bypass as include.
  const extendsFile =
    service.extends && typeof service.extends === 'object'
      ? (service.extends as Record<string, unknown>).file
      : undefined
  if (typeof extendsFile === 'string') {
    issues.push(
      `service '${name}' uses extends.file ('${extendsFile}') — unsupported (the referenced file is merged by the daemon and bypasses the isolation / host-escape checks)`,
    )
  }
  const buildContext = buildContextSource(service.build)
  if (buildContext !== null) {
    if (!build) {
      issues.push(
        `service '${name}' uses build: — image-based stacks only (no repo is checked out)`,
      )
    } else if (escapesCheckout(buildContext, baseDepth)) {
      issues.push(
        `service '${name}' builds from a context outside the checkout ('${buildContext}') — refused (host-filesystem escape)`,
      )
    }
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
    } else if (escapesCheckout(source, baseDepth)) {
      issues.push(
        `service '${name}' bind-mounts a path outside the checkout ('${source}') — refused (host-filesystem escape)`,
      )
    }
  }
  for (const entry of asArray(service.env_file)) {
    const path = typeof entry === 'string' ? entry : (entry as Record<string, unknown> | null)?.path
    if (typeof path !== 'string') continue
    if (refuseHostPath(path)) {
      issues.push(
        build
          ? `service '${name}' reads an env_file outside the checkout ('${path}') — refused (host-filesystem escape)`
          : `service '${name}' reads an env_file ('${path}') — unsupported (no repo on disk)`,
      )
    }
  }
  return issues
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
 *  - ANY `env_file` / secret-or-config `file:` — points into the absent repo tree (or the host);
 *  - `privileged: true` — refused on the shared host daemon.
 *
 * **Build mode** (`opts.build === true`): the PR head is cloned into a working tree, so `build:`
 * contexts, IN-CHECKOUT relative bind mounts, relative `env_file`s, and in-checkout secret/config
 * `file:` sources all resolve and are allowed. Still refused, because they escape the checkout or
 * the daemon's safety envelope — every path-bearing reference (bind source, env_file, build
 * context, secret/config `file:`) is uniformly run through {@link escapesCheckout}, and
 * `privileged: true` stays refused.
 *
 * In BOTH modes, `include:` and cross-file `extends: { file }` are refused outright: the daemon
 * merges those referenced files at build/up time, so their services never pass through this parse
 * (or through `neutralizeHostPorts` / `ensureServicePublishes`) — leaving them in would let a
 * merged file smuggle a privileged container, a host bind, or a pinned port past every guard.
 */
export function collectUnsupportedComposeRefs(
  doc: ComposeDoc,
  opts?: { build?: boolean; baseDepth?: number },
): string[] {
  const build = opts?.build === true
  const baseDepth = opts?.baseDepth ?? 0
  const issues: string[] = []
  // Reject a path that the daemon would resolve against the host / an absent tree. Image mode has
  // no checkout, so any host or repo-relative path is unusable; build mode only refuses one that
  // ESCAPES the cloned checkout (in-checkout relatives resolve against the clone).
  const refuseHostPath = (source: string): boolean =>
    build ? escapesCheckout(source, baseDepth) : true

  // The daemon merges `include:`d files from disk, bypassing this whole guard — refuse it.
  if (doc.include !== undefined) {
    issues.push(
      'compose declares include: — unsupported (included files are merged by the daemon and bypass the isolation / host-escape checks)',
    )
  }
  for (const [name, service] of Object.entries(servicesOf(doc))) {
    if (!service || typeof service !== 'object') continue
    issues.push(...collectServiceComposeIssues(name, service, build, baseDepth, refuseHostPath))
  }
  // Top-level `secrets:` / `configs:` with a host `file:` source are mounted into the service — the
  // same host-path escape surface as a bind mount, so judge them the same way.
  for (const kind of ['secrets', 'configs'] as const) {
    const defs = doc[kind]
    if (!defs || typeof defs !== 'object') continue
    for (const [key, def] of Object.entries(defs as Record<string, unknown>)) {
      const file =
        def && typeof def === 'object' ? (def as Record<string, unknown>).file : undefined
      if (typeof file !== 'string') continue
      if (refuseHostPath(file)) {
        issues.push(
          build
            ? `${kind.slice(0, -1)} '${key}' reads a file outside the checkout ('${file}') — refused (host-filesystem escape)`
            : `${kind.slice(0, -1)} '${key}' reads a host file ('${file}') — unsupported (no repo on disk)`,
        )
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
  opts?: { build?: boolean; baseDepth?: number },
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

// ---------------------------------------------------------------------------
// STACK RECIPES — multi-`-f` layering, profiles, env-file materialization, ordered setup
// steps + a terminal health gate. All pure (no I/O): the provider drives the daemon / host
// through the injected `ComposeRuntime` and streams per-step verdicts to `recordStep`. The
// recipe runs local-facade-only (needs a host daemon), so it always materializes a checkout —
// its steps + env files operate on the working tree, and the compose files are read from it.
// ---------------------------------------------------------------------------

/** Default per-step budget (ms) for a `compose-exec`/`copy-file`/`host-command` step. */
export const DEFAULT_RECIPE_STEP_TIMEOUT_MS = 300_000
/** Default budget (ms) for a `wait-*` step / a non-`compose-healthy` health gate. */
export const DEFAULT_RECIPE_WAIT_TIMEOUT_MS = 300_000
/** Default re-probe interval (ms) for a `wait-*` step / health gate. */
export const DEFAULT_RECIPE_POLL_INTERVAL_MS = 2_000
/** The rewritten-compose filename prefix, written beside each original inside the checkout. */
const RECIPE_REWRITE_PREFIX = 'cat-factory.'

/** The ordered `-f` compose files a recipe layers: `recipe.composeFiles` when set, else `[composePath]`. */
export function resolveRecipeComposeFiles(recipe: StackRecipe, composePath: string): string[] {
  return recipe.composeFiles && recipe.composeFiles.length > 0 ? recipe.composeFiles : [composePath]
}

/** The filename portion of a repo-relative path (`docker/dev.yml` → `dev.yml`). */
function composeFileBase(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const idx = normalized.lastIndexOf('/')
  return idx < 0 ? normalized : normalized.slice(idx + 1)
}

/**
 * Where a rewritten recipe compose file is written inside the checkout: beside its original
 * (so relative build contexts / binds / env_files still resolve), prefixed so it never clobbers
 * the committed file. `docker/dev.yml` → `docker/cat-factory.dev.yml`.
 */
export function rewrittenRecipeComposePath(originalPath: string): string {
  const dir = composeFileDir(originalPath)
  const base = `${RECIPE_REWRITE_PREFIX}${composeFileBase(originalPath)}`
  return dir ? `${dir}/${base}` : base
}

/** One recipe compose file read from the checkout, before rewriting. */
export interface RecipeComposeInput {
  /** Repo-relative path of the original committed file (the rewrite lands beside it). */
  path: string
  /** The (already `{{var}}`-rendered) file text. */
  text: string
}

/** One rewritten, isolation-safe recipe compose file to write into the checkout + pass as `-f`. */
export interface PreparedRecipeComposeFile {
  /** Repo-relative destination for the rewritten file (see {@link rewrittenRecipeComposePath}). */
  path: string
  content: string
}

/** The outcome of preparing a recipe's layered compose files into isolation-safe project files. */
export interface PreparedRecipeCompose {
  files: PreparedRecipeComposeFile[]
  issues: string[]
}

/** Parse one recipe compose layer, returning the doc OR a blocking issue (invalid YAML / non-map). */
function parseRecipeComposeDoc(input: RecipeComposeInput): { doc?: ComposeDoc; issue?: string } {
  let parsed: unknown
  try {
    parsed = parse(input.text)
  } catch (err) {
    return {
      issue: `compose file '${input.path}' is not valid YAML: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { issue: `compose file '${input.path}' is empty or not a mapping` }
  }
  return { doc: parsed as ComposeDoc }
}

/**
 * Rewrite a recipe's LAYERED compose files (base + overrides) into isolation-safe project files,
 * one per input, preserving `-f` order. Each file is parsed, host-escape-checked (build-mode rules:
 * only refs that ESCAPE the checkout are refused — a recipe always has a working tree), and has its
 * published host ports forced ephemeral (so concurrent per-PR stacks never collide). The probed
 * `service`'s port publish is guaranteed on whichever file DEFINES that service; if no file defines
 * it, that is a blocking issue. Compose merges the `-f` layers itself at `up`, so we rewrite each
 * layer independently rather than trying to reproduce compose's merge semantics.
 *
 * When `attachNetworks` is given (slice 5 — the shared-stack managed networks + the recipe's
 * declared external networks), the consumer project is attached to each network the MERGED stack
 * doesn't already declare external: it is declared top-level `external: true` and joined by every
 * service (via {@link attachExternalNetworks}), so the per-PR containers reach the long-lived
 * shared stack over `acme-net`. The "already external" set is computed across ALL layers first, so
 * a network any layer already wires is left entirely alone (never re-attached in an override layer,
 * which could clobber a service's explicit no-default scoping).
 */
export function prepareRecipeComposeFiles(
  inputs: RecipeComposeInput[],
  service: string,
  port: number,
  opts: { baseDepth: number; attachNetworks?: string[] },
): PreparedRecipeCompose {
  const parsedLayers = inputs.map((input) => ({ input, ...parseRecipeComposeDoc(input) }))
  const issues: string[] = []
  let serviceDefined = false
  // Per-layer validation + isolation rewrites (host-escape refs, host-port neutralize, port publish).
  // The external-network attach is DEFERRED until after this loop so it reasons about the MERGED stack
  // (all layers) rather than each layer in isolation — see {@link attachExternalNetworks}.
  for (const { input, doc, issue } of parsedLayers) {
    if (issue || !doc) {
      issues.push(issue ?? `compose file '${input.path}' is empty or not a mapping`)
      continue
    }
    // Recipe files always have a checkout, so use the build-mode guard (escape-only), scoped to the
    // first compose file's dir (the resolved `--project-directory` all layers share).
    for (const refIssue of collectUnsupportedComposeRefs(doc, {
      build: true,
      baseDepth: opts.baseDepth,
    })) {
      issues.push(`${input.path}: ${refIssue}`)
    }
    neutralizeHostPorts(doc)
    if (servicesOf(doc)[service]) {
      serviceDefined = true
      ensureServicePublishes(doc, service, port)
    }
  }
  if (!serviceDefined) {
    issues.push(`no service named '${service}' is defined across the recipe's compose files`)
  }
  // Attach the shared-stack + declared external networks across the merged, normalized layers,
  // surfacing a project-owned name collision as a blocking issue.
  const validDocs = parsedLayers.flatMap(({ doc }) => (doc ? [doc] : []))
  issues.push(...attachExternalNetworks(validDocs, opts.attachNetworks ?? []))
  const files: PreparedRecipeComposeFile[] = parsedLayers.map(({ input, doc }) => ({
    path: rewrittenRecipeComposePath(input.path),
    content: doc ? stringify(doc) : input.text,
  }))
  return { files, issues }
}

/**
 * Blocking host-escape issues for a recipe's checkout-relative paths, collected up front so a bad
 * recipe fails BEFORE the daemon is touched (the `prepareComposeProject` posture). Every path that
 * the engine reads/writes/execs INSIDE the checkout — the `composeFiles` layers (written back beside
 * their originals + feeding `--project-directory`), env-file template+target pairs, `copy-file`
 * from/to, a `compose-exec`/health `stdinFile`, a `host-command` `workdir`, and a checkout-target
 * `wait-file` — is run through {@link escapesCheckout} (repo-root-relative, depth 0). A container-
 * target `wait-file` path (its step names a `service`) is legitimately container-absolute and is
 * NOT checked here. Only `setupSteps` are inspected — `teardownSteps` execution is deferred, so
 * they can't touch the host yet; fold them in here when it lands.
 */
export function recipeCheckoutPathIssues(recipe: StackRecipe): string[] {
  const issues: string[] = []
  const check = (path: string, label: string) => {
    if (escapesCheckout(path, 0)) {
      issues.push(
        `recipe ${label} ('${path}') escapes the checkout — refused (host-filesystem escape)`,
      )
    }
  }
  // The compose-file layers are written back into the checkout + one feeds `--project-directory`, so
  // an escaping path is a host-filesystem write escape — guarded like every other recipe path.
  for (const composeFile of recipe.composeFiles ?? []) {
    check(composeFile, 'compose file')
  }
  for (const env of recipe.envFiles ?? []) {
    check(env.template, 'env-file template')
    check(env.target, 'env-file target')
  }
  for (const step of recipe.setupSteps ?? []) {
    if (step.kind === 'copy-file') {
      check(step.from, `step '${step.name}' from`)
      check(step.to, `step '${step.name}' to`)
    } else if (step.kind === 'compose-exec') {
      if (step.stdinFile) check(step.stdinFile, `step '${step.name}' stdinFile`)
    } else if (step.kind === 'host-command') {
      if (step.workdir) check(step.workdir, `step '${step.name}' workdir`)
    } else if (step.kind === 'wait-file' && !step.service) {
      check(step.path, `step '${step.name}' path`)
    }
  }
  return issues
}

/** The `COMPOSE_PROFILES` env for a recipe (comma-joined), or `{}` when it enables none. */
export function recipeProfilesEnv(recipe: StackRecipe): Record<string, string> {
  const profiles = recipe.composeProfiles ?? []
  return profiles.length > 0 ? { COMPOSE_PROFILES: profiles.join(',') } : {}
}

/** The per-step timeout budget (ms): the step's own `timeoutMs`, else the per-kind default. */
export function recipeStepTimeoutMs(step: RecipeStep): number {
  const perKindDefault =
    step.kind === 'wait-http' || step.kind === 'wait-file'
      ? DEFAULT_RECIPE_WAIT_TIMEOUT_MS
      : DEFAULT_RECIPE_STEP_TIMEOUT_MS
  return step.timeoutMs ?? perKindDefault
}

/** The re-probe interval (ms) of a `wait-*` step: its own `intervalMs`, else the default. */
export function recipeStepIntervalMs(
  step: Extract<RecipeStep, { kind: 'wait-http' | 'wait-file' }>,
): number {
  return step.intervalMs ?? DEFAULT_RECIPE_POLL_INTERVAL_MS
}

/**
 * The `docker compose exec` argv for a `compose-exec` step (or a `compose-exec` health gate),
 * appended to the project `scope`. Always `-T` (no TTY — the engine runs non-interactively); the
 * optional `--user` / `--workdir` precede the service + command argv.
 */
export function composeExecArgs(
  scope: string[],
  step: {
    service: string
    command: string[]
    user?: string
    workdir?: string
  },
): string[] {
  return [
    ...scope,
    'exec',
    '-T',
    ...(step.user ? ['--user', step.user] : []),
    ...(step.workdir ? ['--workdir', step.workdir] : []),
    step.service,
    ...step.command,
  ]
}

/** The `docker compose exec … test -f <path>` argv for a container-target `wait-file` step. */
export function waitFileExecArgs(scope: string[], service: string, path: string): string[] {
  return [...scope, 'exec', '-T', service, 'test', '-f', path]
}

/**
 * Whether an HTTP probe response satisfies a `wait-http` step / `http` health gate: the status
 * matches `expectStatus` when set (else any 2xx), AND the body contains `expectBodyContains` when
 * set. Pure — the provider does the actual `fetch`.
 */
export function matchesHttpExpectation(
  status: number,
  body: string,
  opts: { expectStatus?: number; expectBodyContains?: string },
): boolean {
  const statusOk =
    opts.expectStatus !== undefined ? status === opts.expectStatus : status >= 200 && status < 300
  if (!statusOk) return false
  return opts.expectBodyContains ? body.includes(opts.expectBodyContains) : true
}

/** The terminal readiness gate a recipe resolves to when it declares none (today's `up --wait`). */
export const DEFAULT_RECIPE_HEALTH_GATE: RecipeHealthGate = { kind: 'compose-healthy' }

/** The budget (ms) for a health gate: its own `timeoutMs` (http/compose-exec), else the wait default. */
export function healthGateTimeoutMs(gate: RecipeHealthGate): number {
  return gate.kind === 'compose-healthy'
    ? DEFAULT_RECIPE_WAIT_TIMEOUT_MS
    : (gate.timeoutMs ?? DEFAULT_RECIPE_WAIT_TIMEOUT_MS)
}

/** The re-probe interval (ms) for a health gate: its own `intervalMs` (http/compose-exec), else the default. */
export function healthGateIntervalMs(gate: RecipeHealthGate): number {
  return gate.kind === 'compose-healthy'
    ? DEFAULT_RECIPE_POLL_INTERVAL_MS
    : (gate.intervalMs ?? DEFAULT_RECIPE_POLL_INTERVAL_MS)
}
