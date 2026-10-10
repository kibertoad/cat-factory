import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Infrastructure-setup tracking. A small per-workspace status projection carried
// on the workspace snapshot so the SPA can nag (a loud banner) when a workspace
// runs on a deployment that REQUIRES a piece of infrastructure to be configured
// but the operator hasn't defined it yet. Deliberately an explicit tri-state per
// area (rather than an inferred boolean/absence) so "the operator never made a
// decision" (`not_defined`) is tracked distinctly from "this runtime doesn't need
// it" (`not_applicable`) and "it's set up" (`configured`).
//
// Computed server-side (WorkspaceController) from whatever each facade actually
// wired, so it is runtime-symmetric by construction and needs no persistence:
//   - ephemeral environments — the environment provider connection (all runtimes
//     that wire the environments integration). Unset ⇒ testing agents can't run.
//   - agent executor — the self-hosted runner-pool connection. Only the remote
//     Node facade delegates container agents to a pool (Cloudflare has built-in
//     per-run containers, local runs them on the host), so this is `not_applicable`
//     everywhere except an unconfigured Node deployment. Unset ⇒ NO agents can run.
//   - binary storage — the per-account content-storage backend. Every facade wires an
//     artifact-store resolver, so this is effectively `configured`/`not_defined`, not
//     `not_applicable`: local defaults to a filesystem store and Cloudflare with an
//     `ARTIFACT_BUCKET` binding defaults to R2 (both ⇒ `configured`), while the Node
//     facade defaults to `off` AND a Cloudflare deployment WITHOUT that binding also
//     resolves nothing (both ⇒ `not_defined`). Unset ⇒ screenshot / reference-image
//     storage (the UI-tester + visual-confirmation gate) is off.
// ---------------------------------------------------------------------------

/**
 * The configuration state of one infrastructure area for a workspace:
 *  - `not_defined`    — the deployment can use it, but the operator hasn't set it up
 *                       (the banner-worthy state).
 *  - `configured`     — a connection / backend is defined.
 *  - `not_applicable` — this runtime doesn't need it (the integration isn't wired),
 *                       so there is nothing to nag about.
 *  - `unreachable`    — it IS configured, but a live probe could not reach it.
 *
 * `unreachable` is deliberately carried by this SETUP projection even though it reports runtime
 * health, because the consequence is identical to `not_defined` — a whole class of agents cannot
 * run — and the operator surface that fixes it is the same one. Sharing the projection means
 * sharing the banner, its deep-link and its i18n instead of growing a second "your infra is
 * broken" surface.
 *
 * It is NOT interchangeable with the other three in one respect, and consumers MUST honour the
 * difference: those are stable operator decisions, so the banner offers a PERMANENT per-user
 * "don't notify me again" dismissal. Applying that to `unreachable` would let one click
 * permanently silence every future outage, so a health state is dismissible for the SESSION
 * only and must re-nag when it recurs. See {@link isInfraSetupHealthStatus} and
 * `InfraSetupBanner.vue`.
 */
export const infraSetupStatusSchema = v.picklist([
  'not_defined',
  'configured',
  'not_applicable',
  'unreachable',
])
export type InfraSetupStatus = v.InferOutput<typeof infraSetupStatusSchema>

/**
 * The {@link InfraSetupStatus} values describing a live-HEALTH problem rather than an operator
 * decision. Exported so the SPA's dismissal fork keys off ONE definition instead of re-listing
 * the literal at each site.
 */
export const INFRA_SETUP_HEALTH_STATUSES = ['unreachable'] as const

/** Whether a status is a transient health failure (session-only dismissal, re-nag on recurrence). */
export function isInfraSetupHealthStatus(status: InfraSetupStatus): boolean {
  return (INFRA_SETUP_HEALTH_STATUSES as readonly string[]).includes(status)
}

/** The per-area infrastructure-setup status projection carried on the snapshot. */
export const infraSetupSchema = v.object({
  /** Ephemeral test environments (deployer / provisioning). Relevant on every runtime. */
  ephemeralEnvironments: infraSetupStatusSchema,
  /** The container agent executor (self-hosted runner pool). Relevant only on remote Node. */
  agentExecutor: infraSetupStatusSchema,
  /**
   * Binary/object storage for UI screenshots + reference images. Every facade wires an
   * artifact-store resolver, so this is `configured`/`not_defined` on every runtime — not just
   * remote Node: a Cloudflare deployment WITHOUT an `ARTIFACT_BUCKET` binding (or any account
   * that selected no backend) reads `not_defined` too.
   */
  binaryStorage: infraSetupStatusSchema,
})
export type InfraSetup = v.InferOutput<typeof infraSetupSchema>

/** The infrastructure areas the setup banner surfaces (leaf names mirror {@link infraSetupSchema}). */
export const infraSetupAreaSchema = v.picklist([
  'ephemeralEnvironments',
  'agentExecutor',
  'binaryStorage',
])
export type InfraSetupArea = v.InferOutput<typeof infraSetupAreaSchema>

/** Every infra-setup area, as a plain readonly tuple (the source of truth for iteration). */
export const INFRA_SETUP_AREAS = infraSetupAreaSchema.options

/**
 * The areas the reachability watcher can report `unreachable` for — those backed by a connection
 * whose provider exposes a live connection probe. `binaryStorage` is deliberately ABSENT: it
 * resolves an artifact store from account settings and has no cheap reachability probe, so it
 * stays a pure operator-decision area and a dead bucket surfaces where it always did (on the
 * write that needs it). Shared so the watcher, the projection fold and the tests agree on ONE
 * list rather than each re-deriving "which areas can be unreachable".
 */
export const INFRA_SETUP_PROBED_AREAS = [
  'ephemeralEnvironments',
  'agentExecutor',
] as const satisfies readonly InfraSetupArea[]

/** An area the reachability watcher can report on (a member of {@link INFRA_SETUP_PROBED_AREAS}). */
export type InfraSetupProbedArea = (typeof INFRA_SETUP_PROBED_AREAS)[number]

/**
 * Whether an area is one the watcher probes — a TYPE GUARD, so a consumer keyed on the probed
 * subset (the outage copy has a per-area title; `binaryStorage` has none because it can never be
 * unreachable) narrows instead of carrying a dead entry for an area that cannot reach it.
 */
export function isInfraSetupProbedArea(area: InfraSetupArea): area is InfraSetupProbedArea {
  return (INFRA_SETUP_PROBED_AREAS as readonly InfraSetupArea[]).includes(area)
}

/**
 * Apply ONE observed reachability status to an area of a setup projection.
 *
 * This is the single definition of which prior state a probe verdict may overwrite, and BOTH
 * delivery paths fold through it: the backend's snapshot projection (kernel's
 * `applyInfraReachability`, folding the areas recorded on the open card) and the SPA store's
 * live `infraSetup` event patch. They diverged once — the snapshot guarded the write and the live
 * patch assigned unconditionally — so a pushed `unreachable` rendered a red "check that the
 * service is running" banner for an area the projection called `not_applicable`, which then
 * vanished on the next reload. Live and reloaded state must agree, so the rule lives here.
 *
 * Only a `configured` area may become `unreachable`: the other states OUT-RANK a probe verdict.
 * `not_defined` means the connection is gone (the actionable nag is "set it up", and a lingering
 * outage would report on something that no longer exists) and `not_applicable` means this
 * deployment does not use the area at all. Symmetrically, a recovery only clears an area this
 * projection currently calls `unreachable`, so a stale in-flight push cannot overwrite a
 * freshly-read `not_defined` with `configured`.
 *
 * Returns the projection UNCHANGED (by identity) when the status may not be applied, so a caller
 * can cheaply tell "nothing moved" from a real transition.
 */
export function applyInfraSetupTransition(
  projection: InfraSetup,
  area: InfraSetupArea,
  status: InfraSetupStatus,
): InfraSetup {
  const current = projection[area]
  const allowed = isInfraSetupHealthStatus(status)
    ? current === 'configured'
    : current === 'unreachable'
  if (!allowed || current === status) return projection
  return { ...projection, [area]: status }
}

/**
 * The `localStorage` key under which the SPA's `InfraSetupBanner` persists its PERMANENT,
 * per-user "don't notify me again" dismissals ({@link InfraSetupArea}[] keyed by user id).
 * Lives in this dependency-free contracts package — rather than only inside the Vue component —
 * so the SPA and the e2e suite (which seeds the same key to suppress the banner) share ONE
 * source of truth and can't drift.
 */
export const INFRA_SETUP_DISMISSED_STORAGE_KEY = 'cat-factory:infra-setup-dismissed'
