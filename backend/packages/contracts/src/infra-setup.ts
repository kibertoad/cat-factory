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
 */
export const infraSetupStatusSchema = v.picklist(['not_defined', 'configured', 'not_applicable'])
export type InfraSetupStatus = v.InferOutput<typeof infraSetupStatusSchema>

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
 * The `localStorage` key under which the SPA's `InfraSetupBanner` persists its PERMANENT,
 * per-user "don't notify me again" dismissals ({@link InfraSetupArea}[] keyed by user id).
 * Lives in this dependency-free contracts package — rather than only inside the Vue component —
 * so the SPA and the e2e suite (which seeds the same key to suppress the banner) share ONE
 * source of truth and can't drift.
 */
export const INFRA_SETUP_DISMISSED_STORAGE_KEY = 'cat-factory:infra-setup-dismissed'
