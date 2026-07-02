// Port for "where a browsable frontend PREVIEW actually runs" — the long-lived analogue
// of {@link RunnerTransport}. A preview builds + serves a `frontend` frame's app (with its
// other upstreams mocked) inside a container and KEEPS IT RUNNING past the build job, so a
// developer can open it in a browser. Unlike a runner job (a per-run container reclaimed
// when the run finishes), a preview container:
//   - publishes the served app's port to a HOST-reachable port (the transport forms the
//     browsable URL from it — the harness only knows its in-container url), and
//   - is NOT stopped until an explicit {@link PreviewTransport.stop}.
//
// This is a genuine runtime-specific differentiator: only a runtime with a host-port-publish
// primitive (the local Docker/Podman/… + Apple `container` adapters) wires it. The Worker
// (per-request, ephemeral) never does — it reports `frontendPreview.supported: false` and the
// preview module stays unwired there. The runtime-NEUTRAL half (the PreviewService, its
// persistence, the controller + capability gate) is symmetric across facades; only THIS
// transport is per-runtime, exactly like the Cloudflare-Container-only execution path.

/**
 * The harness job id inside a preview container. A preview container is single-purpose (it runs
 * exactly ONE build+serve job), so the id is a constant — the facade's job builder stamps it on
 * the dispatched body and the transport polls it back, with no cross-layer id to thread.
 */
export const PREVIEW_HARNESS_JOB_ID = 'preview'

/**
 * The `provisionType`/`providerId`/`engine` discriminator a running preview is persisted with in
 * the shared `environments` table. It is deliberately OUTSIDE `provisionTypeSchema` (previews are
 * not a user-selectable provision kind), so the environment subsystem filters rows carrying it out
 * of its generic listing + block-resolution paths — a preview is owned solely by the PreviewService.
 */
export const PREVIEW_PROVISION_TYPE = 'preview'

/** Addresses one preview: the workspace + the `frontend` frame it serves (its stable id). */
export interface PreviewRef {
  workspaceId: string
  /** The `frontend` frame this preview builds + serves; the preview's stable identity. */
  frameId: string
}

/** A preview's current state, as the transport reports it. */
export interface PreviewView {
  /**
   * - `starting` — the container is up and building/serving; no reachable URL yet.
   * - `running`  — the app is served and reachable at {@link url}.
   * - `failed`   — the build never came up / the container vanished (see {@link error}).
   */
  state: 'starting' | 'running' | 'failed'
  /** The HOST-reachable browsable URL (from the published serve port); set only when `running`. */
  url?: string
  /** A failure message when `state === 'failed'`. */
  error?: string
  /** The harness's structured failure cause when `state === 'failed'`, when available. */
  failureCause?: string
}

/**
 * Starts, polls, and stops a long-lived browsable frontend preview container. Wired only on
 * a runtime that can publish a container port to the host (local Docker/… + Apple); absent
 * elsewhere (the preview module then stays unwired and the controller 503s).
 */
export interface PreviewTransport {
  /**
   * Start (or re-attach to) the preview container for `ref`, publishing the in-container
   * `servePort` to an ephemeral host port and dispatching the build+serve job carried in
   * `spec`. Returns once the container is up and the job accepted — the build continues,
   * observed via {@link poll}. Idempotent per ref (a re-start replaces any prior container).
   */
  start(ref: PreviewRef, spec: Record<string, unknown>, servePort: number): Promise<void>
  /** Poll the preview's current state (mapping the build job + the published host URL). */
  poll(ref: PreviewRef): Promise<PreviewView>
  /** Stop + reclaim the preview container. Best-effort and idempotent (a gone preview is a no-op). */
  stop(ref: PreviewRef): Promise<void>
}
