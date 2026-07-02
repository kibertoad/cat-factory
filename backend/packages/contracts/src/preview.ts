import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Browsable frontend preview state (slice 5c of the frontend-preview initiative).
//
// A `frontend` frame can be built + served on a HOST-reachable URL for a browsable
// preview (local/node only — the Worker reports `frontendPreview.supported: false`).
// The running preview is persisted like an ephemeral `environments` row keyed by the
// frame; this is the projection the controller returns and the SPA (slice 5d) renders
// as a clickable URL + a stop button on the frame inspector.
// ---------------------------------------------------------------------------

/**
 * A preview's lifecycle status:
 *   - `starting` — the container is building/serving; no reachable URL yet.
 *   - `ready`    — the app is served and reachable at {@link previewStateSchema.url}.
 *   - `failed`   — the build never came up (see `error`).
 *   - `stopped`  — no preview is running for the frame (never started, or explicitly stopped).
 */
export const previewStatusSchema = v.picklist(['starting', 'ready', 'failed', 'stopped'])
export type PreviewStatus = v.InferOutput<typeof previewStatusSchema>

/** The current state of a `frontend` frame's browsable preview. */
export const previewStateSchema = v.object({
  /** The `frontend` frame this preview serves. */
  frameId: v.string(),
  status: previewStatusSchema,
  /** The browsable host-reachable URL; present only when `status: 'ready'`. */
  url: v.optional(v.string()),
  /** A failure message when `status: 'failed'`. */
  error: v.optional(v.string()),
  /** Epoch ms of the last state change. */
  updatedAt: v.number(),
})
export type PreviewState = v.InferOutput<typeof previewStateSchema>
