import { DEFAULT_FRONTEND_SERVE_PORT } from './frontend.js'
import type { Block, Pipeline } from './entities.js'

// ---------------------------------------------------------------------------
// Visual-pipeline gating (shared by the SPA surface + the backend run-start gate).
//
// A "visual" pipeline exercises a rendered UI — it either drives a real browser
// against a running frontend (`tester-ui`) or parks for a human to review the
// captured screenshots vs the task's reference designs (`visual-confirmation`).
// Such a pipeline only makes sense where there IS a UI to exercise: a `frontend`
// frame (it owns the app under test), or a frame a `frontend` frame links to (the
// linked frontend is the UI a change to that service is validated through). The SPA
// uses these predicates to surface visual pipelines only where they can run; the
// backend gates a run start on the SAME rule so the guarantee holds server-side.
// ---------------------------------------------------------------------------

/**
 * The agent kind that drives a real browser against a running frontend and captures a
 * screenshot of each distinct view. The canonical slug also backs orchestration's
 * `UI_TESTER_AGENT_KIND` (re-exported there); this package is the single source of truth.
 */
export const UI_TESTER_AGENT_KIND = 'tester-ui'

/**
 * The agent kind of the human visual-confirmation gate: it parks for a person to review the
 * UI tester's screenshots against the task's uploaded reference designs. The canonical slug
 * also backs orchestration's `VISUAL_CONFIRM_AGENT_KIND` (re-exported there).
 */
export const VISUAL_CONFIRM_AGENT_KIND = 'visual-confirmation'

/** The visual step kinds: a pipeline carrying any of these is a "visual" pipeline. */
export const VISUAL_STEP_KINDS = [UI_TESTER_AGENT_KIND, VISUAL_CONFIRM_AGENT_KIND] as const

/** Whether a pipeline includes any visual step (`tester-ui` / `visual-confirmation`). */
export function pipelineHasVisualStep(pipeline: Pick<Pipeline, 'agentKinds'>): boolean {
  return pipeline.agentKinds.some(
    (kind) => kind === UI_TESTER_AGENT_KIND || kind === VISUAL_CONFIRM_AGENT_KIND,
  )
}

/**
 * Whether a visual pipeline may run on a task under `frame`. A visual step needs a UI to
 * exercise, which exists when the enclosing frame is either:
 *   - a `frontend` frame (it owns the app under test), or
 *   - a non-frontend frame that some `frontend` frame BINDS as a backend service (a
 *     frontend→service link in that frontend's `frontendConfig.backendBindings`) — the linked
 *     frontend is the UI a change to this service is validated through.
 * Every other frame (a service with no linked frontend, a `library`/`document` repo) has no UI,
 * so a visual pipeline is refused. `blocks` is the workspace's block list, scanned once for the
 * frontend→service links (never a per-frame point read).
 */
export function frameAllowsVisualPipeline(
  frame: Pick<Block, 'id' | 'type'> | undefined | null,
  blocks: readonly Pick<Block, 'level' | 'type' | 'frontendConfig'>[],
): boolean {
  if (!frame) return false
  if (frame.type === 'frontend') return true
  return blocks.some(
    (b) =>
      b.level === 'frame' &&
      b.type === 'frontend' &&
      (b.frontendConfig?.backendBindings ?? []).some(
        (bind) => bind.source.kind === 'service' && bind.source.serviceBlockId === frame.id,
      ),
  )
}

/**
 * The browser origins of every `frontend` frame that binds `serviceFrameId` as a backend
 * service — the origins that service's ephemeral env must accept (CORS; also OAuth callback
 * hosts). It is the REVERSE of `FrontendConfig.backendBindings` (frontend→service) and mirrors
 * `frameAllowsVisualPipeline`'s single-pass scan (never a per-frame point read): a deployer
 * exposes the result as `{{input.frontendOrigins}}` so an operator's `secretInjections`
 * `valueTemplate` / helm `--set` can fold it into the backend's CORS env var.
 *
 * Only a binding with a NON-EMPTY `envVar` counts: an empty-`envVar` row is filtered out of the
 * injected env (the frontend never receives that backend's URL, so its browser never calls it,
 * so no cross-origin request to allow). Each contributing frontend emits its tester origin
 * `http://localhost:<servePort>` (the self-contained UI-test serves the app there). Deduped +
 * sorted for a stable comma-join. (The browsable-preview origin is a local-mode differentiator
 * added once the preview host port is pinned — see the frontend-preview initiative.)
 */
export function frontendOriginsForService(
  serviceFrameId: string,
  blocks: readonly Pick<Block, 'level' | 'type' | 'frontendConfig'>[],
): string[] {
  const origins = new Set<string>()
  for (const b of blocks) {
    if (b.level !== 'frame' || b.type !== 'frontend' || !b.frontendConfig) continue
    const bindsService = b.frontendConfig.backendBindings.some(
      (bind) =>
        bind.source.kind === 'service' &&
        bind.source.serviceBlockId === serviceFrameId &&
        bind.envVar.trim().length > 0,
    )
    if (!bindsService) continue
    const servePort = b.frontendConfig.servePort ?? DEFAULT_FRONTEND_SERVE_PORT
    origins.add(`http://localhost:${servePort}`)
  }
  return [...origins].sort()
}
