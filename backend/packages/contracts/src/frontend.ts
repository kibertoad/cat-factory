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
