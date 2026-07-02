import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Frontend board block config.
//
// A `frontend`-type frame carries a serialized `FrontendConfig` (stored on the
// block, mirroring how `provisioning` is stored on a service frame). It declares
// HOW to build and serve the app for a self-contained UI test — the package
// manager, build script, serve mode, and the WireMock mappings dir — plus the
// backend bindings that ARE both the config and the board link: each binding
// names an env var and where it resolves (a bound service's ephemeral env URL, or
// WireMock). Every field is optional except `backendBindings`; the harness /
// job-body builder fills the defaults (pnpm, `build`, `dist`, static serve, …).
// ---------------------------------------------------------------------------

/**
 * Default WireMock `--root-dir` in the FE repo when a `frontend` frame declares no
 * {@link frontendConfigSchema.mockMappingsPath}. The single source of truth shared by the
 * frontend-aware mocker prompt (`@cat-factory/agents`) and the harness `frontend` infra spec —
 * WireMock reads stubs from `<dir>/mappings/*.json` + `<dir>/__files/` under it. (The harness
 * package keeps its own literal copy because bumping it is an image-tag change; keep the two in
 * lock-step.)
 */
export const DEFAULT_FRONTEND_MOCK_MAPPINGS_PATH = 'mocks/'

/**
 * The default in-container port the built frontend is served on for a UI test / preview.
 * Deliberately NOT 8080 (the harness's own job HTTP server) nor the WireMock port. Used via
 * {@link resolveFrontendServePort} — the single source of truth for the served port, shared by
 * the server's `resolveServePort` and the reverse-origin derivation (`frontendOriginsForService`)
 * so the tester origin a backend must allow (CORS) can't drift from the port the app is actually
 * served on.
 */
export const DEFAULT_FRONTEND_SERVE_PORT = 4173

/** The in-container port the harness's own job HTTP server binds — a frontend must never serve on it. */
export const FRONTEND_HARNESS_JOB_PORT = 8080

/** The in-container port WireMock binds for a frontend UI test (backend-chosen, not user config). */
export const FRONTEND_WIREMOCK_PORT = 8089

/**
 * The port a `frontend` frame's app is ACTUALLY served on: the user's `servePort` unless it
 * collides with a reserved in-container port ({@link FRONTEND_HARNESS_JOB_PORT} 8080, or
 * {@link FRONTEND_WIREMOCK_PORT} 8089), in which case it would fail to bind (or steal WireMock's
 * port), so we fall back to {@link DEFAULT_FRONTEND_SERVE_PORT}. The inspector steers users to
 * 4173, but nothing stops them typing a reserved port, so guard here. Shared by the harness infra
 * spec (`buildFrontendInfraSpec`) and the reverse-origin derivation (`frontendOriginsForService`)
 * so the served port and the CORS origin a backend must allow can't drift.
 */
export function resolveFrontendServePort(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_FRONTEND_SERVE_PORT
  if (requested === FRONTEND_HARNESS_JOB_PORT || requested === FRONTEND_WIREMOCK_PORT) {
    return DEFAULT_FRONTEND_SERVE_PORT
  }
  return requested
}

/** The package manager the frontend build uses. Defaults to `pnpm`. */
export const frontendPackageManagerSchema = v.picklist(['pnpm', 'npm', 'yarn'])
export type FrontendPackageManager = v.InferOutput<typeof frontendPackageManagerSchema>

/**
 * How the built app is served in the UI-test container:
 *   - `static`  — serve the built `outputDir` with a static file server (default).
 *   - `command` — run a package.json script (`serveScript`, e.g. `preview`).
 */
export const frontendServeModeSchema = v.picklist(['static', 'command'])
export type FrontendServeMode = v.InferOutput<typeof frontendServeModeSchema>

/**
 * When the resolved backend URLs are injected into the frontend:
 *   - `build`   — as build-time env vars (default; a `VITE_*`/`PUB_*` build).
 *   - `runtime` — written into a `window.env` shim served alongside the app.
 */
export const frontendEnvInjectionSchema = v.picklist(['build', 'runtime'])
export type FrontendEnvInjection = v.InferOutput<typeof frontendEnvInjectionSchema>

/**
 * Where one of the frontend's backend env vars resolves at test/preview time:
 *   - `service` — that service frame's live ephemeral-environment URL (the
 *     "service under test"). `serviceBlockId` is the bound service frame's block id.
 *   - `mock`    — WireMock on localhost (every upstream that is NOT the service
 *     under test resolves here).
 */
export const frontendBackendSourceSchema = v.variant('kind', [
  v.object({
    kind: v.literal('service'),
    serviceBlockId: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    kind: v.literal('mock'),
  }),
])
export type FrontendBackendSource = v.InferOutput<typeof frontendBackendSourceSchema>

/**
 * One backend binding: the env var the frontend reads for an upstream URL, and
 * where that URL comes from. This is BOTH the user-declared config (env-var name
 * + which upstream) AND the board link (a `service` source draws a frontend→service
 * edge). The "service under test" is the bound `service` source whose ephemeral env
 * is live; every other binding resolves to WireMock.
 */
export const frontendBackendBindingSchema = v.object({
  /**
   * The frontend's env var name for this upstream URL (e.g. `PUB_BACKEND_URL`). May be
   * empty as a transient editing state (a freshly-added inspector row before the user
   * types a name); the infra/job-body builder filters empty-envVar bindings out, so an
   * empty one is inert rather than injected.
   */
  envVar: v.pipe(v.string(), v.trim(), v.maxLength(200)),
  source: frontendBackendSourceSchema,
})
export type FrontendBackendBinding = v.InferOutput<typeof frontendBackendBindingSchema>

/**
 * The non-empty `envVar` names that appear on MORE THAN ONE backend binding. Two bindings
 * sharing an env var is a real misconfiguration — the injected env is a map, so one silently
 * clobbers the other (`resolveFrontendBindings` keeps the last). Advisory only: this is NOT a
 * `v.check` on {@link frontendConfigSchema}, because a binding row persists per-blur and allows
 * an empty `envVar` (a freshly-added row), so a schema-level reject would 422 a mid-edit PATCH
 * (e.g. duplicate a row, then rename it). The inspector + the run-start soft note surface it
 * instead. Empty names are ignored (an unfinished row is inert). Sorted for stable output.
 */
export function duplicateBindingEnvVars(config: Pick<FrontendConfig, 'backendBindings'>): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const binding of config.backendBindings) {
    const name = binding.envVar.trim()
    if (!name) continue
    if (seen.has(name)) duplicates.add(name)
    else seen.add(name)
  }
  return [...duplicates].sort()
}

/**
 * Which branch the frontend is built from for a UI test / preview:
 *   - `'default'` — the frontend repo's default branch (the baseline).
 *   - `{ fromTaskBlockId }` — the PR branch of a linked frontend task block, so a
 *     UI test runs against that task's unmerged work.
 * Absent ⇒ `'default'`.
 */
export const frontendBranchSchema = v.variant('kind', [
  v.object({ kind: v.literal('default') }),
  v.object({
    kind: v.literal('task'),
    fromTaskBlockId: v.pipe(v.string(), v.minLength(1)),
  }),
])
export type FrontendBranch = v.InferOutput<typeof frontendBranchSchema>

/**
 * Service-level (frame-only, `type: 'frontend'`): how to build, serve, and mock
 * this frontend for a self-contained UI test (and, on local/node, an optional
 * browsable preview). Stored serialized on the block. All fields optional except
 * {@link backendBindings}; the harness / job-body builder supplies the defaults
 * (packageManager `pnpm`, buildScript `build`, outputDir `dist`, serveMode
 * `static`, servePort 4173, envInjection `build`, mockMappingsPath `mocks/`, and
 * the repo root when {@link directory} is absent).
 */
export const frontendConfigSchema = v.object({
  /** Package manager for install/build. Default `pnpm`. */
  packageManager: v.optional(frontendPackageManagerSchema),
  /** Explicit install command, overriding the one derived from `packageManager`. */
  installCommand: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /** package.json script name that produces the built app. Default `build`. */
  buildScript: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  /** The build's output directory, served in `static` mode. Default `dist`. */
  outputDir: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /**
   * The frontend app's subdirectory within the repo (a monorepo frontend, e.g. `frontend/` or
   * `apps/web`). Absent ⇒ the repo root. When set, the harness runs install/build/serve there and
   * every other path (`outputDir`, `mockMappingsPath`) is relative to it.
   */
  directory: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /** How the built app is served. Default `static`. */
  serveMode: v.optional(frontendServeModeSchema),
  /** package.json script to run when `serveMode: 'command'` (e.g. `preview`). */
  serveScript: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
  /**
   * The port the served app listens on inside the container. Default 4173 (deliberately NOT
   * 8080: the harness's own job HTTP server owns 8080 in the same container). Avoid 8080.
   */
  servePort: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  /** Build-time env vars vs a runtime `window.env` shim. Default `build`. */
  envInjection: v.optional(frontendEnvInjectionSchema),
  /** Which branch to build for a UI test / preview. Absent ⇒ the FE default branch. */
  branch: v.optional(frontendBranchSchema),
  /**
   * WireMock's `--root-dir` in the FE repo. Default `mocks/`. NOTE: WireMock loads stubs from a
   * `mappings/` subdirectory (and response bodies from `__files/`) UNDER this dir — so with the
   * default, put stub JSON in `mocks/mappings/`, not directly in `mocks/`. A dir with no
   * `mappings/` inside starts an empty WireMock that 404s every mocked call.
   */
  mockMappingsPath: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /** Browsable preview (local/node only). Default false. */
  previewEnabled: v.optional(v.boolean()),
  /**
   * The frontend's backend upstreams: env-var name → where the URL resolves. Both
   * the config and the board link. Required (may be empty for a frontend with no
   * backend upstreams, but the field is always present).
   */
  backendBindings: v.array(frontendBackendBindingSchema),
})
export type FrontendConfig = v.InferOutput<typeof frontendConfigSchema>

// ---------------------------------------------------------------------------
// Frontend backend-binding RESOLUTION (pure, shared by the backend + the SPA).
//
// A frontend declares backend BINDINGS (env-var name → where its URL resolves). At UI-test /
// preview time each `service` binding whose bound service has a LIVE ephemeral env resolves to
// that env's real URL (a "service under test"); every `mock` binding — and every `service` with
// no live env — is left for WireMock. These helpers do that resolution with NO IO, so the exact
// same rule drives the run-start gate (orchestration), the reverse-origin CORS injection, the
// inspector's resolved-binding view, and the run-detail projection — they can't drift. (They
// live here, next to `frontendOriginsForService`, for the same reason: one source of truth the
// backend and the SPA both import.)
// ---------------------------------------------------------------------------

/** A frontend backend binding resolved to a concrete upstream for a UI-test / preview run. */
export const resolvedFrontendBindingSchema = v.object({
  /** The frontend's env var for this upstream URL (e.g. `PUB_BACKEND_URL`). */
  envVar: v.string(),
  /** The bound service's live ephemeral env URL (the service under test); absent ⇒ mocked. */
  serviceUrl: v.optional(v.string()),
})
export type ResolvedFrontendBinding = v.InferOutput<typeof resolvedFrontendBindingSchema>

/** A live-environment handle as far as the frontend binding resolution cares. */
export interface LiveEnvHandle {
  frameId?: string | null
  url?: string | null
  status: string
  createdAt: number
}

/** The distinct service FRAME ids a frontend config binds via a `service` source. */
export function boundServiceFrameIds(config: Pick<FrontendConfig, 'backendBindings'>): Set<string> {
  return new Set(
    config.backendBindings
      .filter((b) => b.source.kind === 'service')
      .map((b) => (b.source as { serviceBlockId: string }).serviceBlockId),
  )
}

/**
 * Index live-environment handles to a `serviceFrameId → url` map for the service FRAMES a
 * frontend binds. A binding's `serviceBlockId` names a service FRAME, so we match on the handle's
 * `frameId` (the deployer's block walked up to its frame), NOT `blockId` (the task the deployer
 * ran on). A frame can hold more than one live env (two tasks under it each ran a deployer, since
 * supersede is per-task `blockId`), so keep the NEWEST by `createdAt` — the "current env wins"
 * rule the tester point-read applies via `ORDER BY created_at DESC`. Shared by the backend
 * (AgentContextBuilder / the preview job builder) and the SPA's live-binding view so the two
 * can't drift on which env a live `service` binding resolves to.
 */
export function indexLiveServiceEnvUrls(
  handles: Iterable<LiveEnvHandle>,
  serviceFrameIds: ReadonlySet<string>,
): Map<string, string> {
  const liveServiceEnvUrls = new Map<string, string>()
  if (serviceFrameIds.size === 0) return liveServiceEnvUrls
  const newestAt = new Map<string, number>()
  for (const handle of handles) {
    if (
      handle.frameId &&
      handle.url &&
      handle.status === 'ready' &&
      serviceFrameIds.has(handle.frameId) &&
      handle.createdAt >= (newestAt.get(handle.frameId) ?? Number.NEGATIVE_INFINITY)
    ) {
      newestAt.set(handle.frameId, handle.createdAt)
      liveServiceEnvUrls.set(handle.frameId, handle.url)
    }
  }
  return liveServiceEnvUrls
}

/**
 * Resolve a frontend frame's backend bindings to concrete upstreams. Each `service` binding whose
 * service FRAME id is in `liveServiceEnvUrls` becomes the service under test (its real URL); every
 * `mock` source — and every `service` with no live env — is left for the harness to mock (no
 * `serviceUrl`). Empty env-var bindings (an unfinished inspector row, allowed by the schema) are
 * dropped so nothing inert is ever injected.
 *
 * The injected env is a MAP keyed by `envVar`, so two bindings sharing a (non-empty) `envVar`
 * can't both survive — we keep the LAST (deterministic: whatever the operator sees at the bottom
 * of the inspector list wins) rather than letting Map insertion order decide silently. The
 * duplicate names are surfaced by {@link duplicateBindingEnvVars} (inspector warning) and the
 * run-start soft note ({@link buildFrontendRunNotes}); this just makes the resolved result match
 * that "last wins" rule.
 */
export function resolveFrontendBindings(
  config: Pick<FrontendConfig, 'backendBindings'>,
  liveServiceEnvUrls: ReadonlyMap<string, string>,
): ResolvedFrontendBinding[] {
  const byEnvVar = new Map<string, ResolvedFrontendBinding>()
  for (const binding of config.backendBindings) {
    const envVar = binding.envVar.trim()
    if (!envVar) continue
    const serviceUrl =
      binding.source.kind === 'service'
        ? liveServiceEnvUrls.get(binding.source.serviceBlockId)
        : undefined
    byEnvVar.set(envVar, serviceUrl ? { envVar, serviceUrl } : { envVar })
  }
  return [...byEnvVar.values()]
}

/**
 * Non-fatal advisories about a frontend UI-test / preview run's resolved backend bindings — the
 * SPA-visible mirror of the harness's own `buildInfraNotes`. Two cases, both a misconfiguration
 * the run tolerates rather than a failure:
 *   - **duplicate env vars** — more than one binding names the same env var; only the last takes
 *     effect (see {@link resolveFrontendBindings}), so the others silently do nothing.
 *   - **partial-live** — at least one bound service resolved to a live env (so the run started),
 *     but another bound service has no live env and falls back to WireMock. (A frontend where NO
 *     bound service is live is refused at the start gate, so that case never reaches here.)
 * Pure + no IO so the wording/ordering is unit-tested; empty array ⇒ nothing to flag.
 */
export function buildFrontendRunNotes(
  config: Pick<FrontendConfig, 'backendBindings'>,
  liveServiceEnvUrls: ReadonlyMap<string, string>,
): string[] {
  const notes: string[] = []
  const duplicates = duplicateBindingEnvVars(config)
  if (duplicates.length > 0) {
    notes.push(
      `More than one backend binding uses the env var${duplicates.length === 1 ? '' : 's'} ` +
        `${duplicates.join(', ')}; only the last binding for each takes effect and the earlier ` +
        `ones are ignored. Give each upstream a distinct env var.`,
    )
  }
  const serviceBindings = config.backendBindings.filter(
    (b) => b.source.kind === 'service' && b.envVar.trim().length > 0,
  )
  const serviceFrameId = (b: (typeof serviceBindings)[number]) =>
    (b.source as { serviceBlockId: string }).serviceBlockId
  const anyLive = serviceBindings.some((b) => liveServiceEnvUrls.has(serviceFrameId(b)))
  const mocked = [
    ...new Set(
      serviceBindings
        .filter((b) => !liveServiceEnvUrls.has(serviceFrameId(b)))
        .map((b) => b.envVar.trim()),
    ),
  ].sort()
  if (anyLive && mocked.length > 0) {
    notes.push(
      `${mocked.length === 1 ? 'A bound service has' : 'Some bound services have'} no live ` +
        `environment, so ${mocked.join(', ')} ${mocked.length === 1 ? 'is' : 'are'} served by ` +
        `WireMock instead of the real backend. Provision ${mocked.length === 1 ? 'it' : 'them'} ` +
        `to exercise the live service.`,
    )
  }
  return notes
}

// ---------------------------------------------------------------------------
// Frontend config AUTO-DETECTION (the "Detect from repo" affordance): a deterministic,
// checkout-free heuristic reads the frontend repo and proposes a NON-BINDING recommended
// {@link FrontendConfig} — the package manager (from the lockfile), install command, build
// script + output dir (from package.json + framework markers), serve mode/script, and the
// backend-binding env-var names (from dotenv examples). The SPA shows the recommendation with
// per-field confidence notes; the user always confirms/edits before it is applied. Mirrors the
// service-provisioning detector (`detectServiceProvisioningSchema`/`provisioningRecommendationSchema`).
// ---------------------------------------------------------------------------

/** Confidence in a single inferred frontend-config aspect. */
export const frontendDetectionConfidenceSchema = v.picklist(['high', 'low'])
export type FrontendDetectionConfidence = v.InferOutput<typeof frontendDetectionConfidenceSchema>

/** One inferred aspect of the frontend recommendation, with its confidence + a human rationale. */
export const frontendDetectionNoteSchema = v.object({
  /**
   * Which field this note explains: `packageManager` | `installCommand` | `buildScript` |
   * `outputDir` | `serveMode` | `backendBindings` (a leaf i18n key mirrors these verbatim).
   */
  field: v.string(),
  confidence: frontendDetectionConfidenceSchema,
  /** Rationale for the SPA to surface (e.g. "pnpm-lock.yaml present ⇒ pnpm"). */
  message: v.pipe(v.string(), v.maxLength(500)),
})
export type FrontendDetectionNote = v.InferOutput<typeof frontendDetectionNoteSchema>

/**
 * A non-binding recommended {@link FrontendConfig} for a frontend repo, with per-field confidence
 * notes. `detected` is false when the repo couldn't be read or nothing frontend-shaped was found
 * (the `config` is then a bare `{ backendBindings: [] }`). Nothing is persisted — the SPA prefills
 * a preview the user applies. `config` reuses {@link frontendConfigSchema} (every field optional,
 * `backendBindings` always present), so an applied recommendation is a valid config patch.
 */
export const frontendConfigRecommendationSchema = v.object({
  detected: v.boolean(),
  /** The prefilled frontend config the user reviews/applies. */
  config: frontendConfigSchema,
  /** Per-field confidence + hints for the SPA. */
  notes: v.array(frontendDetectionNoteSchema),
})
export type FrontendConfigRecommendation = v.InferOutput<typeof frontendConfigRecommendationSchema>

/**
 * Detect a recommended frontend config for a repo (nothing persisted). The repo is read at
 * `gitRef` (absent ⇒ default branch); `directory` scopes detection to the frontend's subdirectory
 * (absent ⇒ the repo root).
 */
export const detectFrontendConfigSchema = v.object({
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  /** Branch/tag/sha to read at; absent ⇒ the repo's default branch. */
  gitRef: v.optional(v.pipe(v.string(), v.minLength(1))),
  /** The frontend app's subdirectory within the repo; absent ⇒ the repo root. */
  directory: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /** Optional VCS provider hint; absent ⇒ the workspace's connected provider. */
  provider: v.optional(v.picklist(['github', 'gitlab'])),
})
export type DetectFrontendConfigInput = v.InferOutput<typeof detectFrontendConfigSchema>
