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
 * `static`, servePort 4173, envInjection `build`, mockMappingsPath `mocks/`).
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
