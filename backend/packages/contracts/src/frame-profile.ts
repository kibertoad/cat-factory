import type { BlockType } from './primitives.js'

// ---------------------------------------------------------------------------
// Frame capability profile (shared by the SPA + the backend engine/prompts).
//
// A frame's `type` is the user-facing behavioural classification (`service` /
// `frontend` / `library` / `document` + the cosmetic block kinds). This turns that
// single fact into the four capability flags the engine + prompts actually branch on,
// so the behaviour of every step ADAPTS to the frame it runs on instead of scattering
// `type === 'library'` checks across the deployer, the tester gate, the prompts, and
// the SPA. It is the "capability profile" shape from the library-frame-support
// initiative (option 2/3): a pure table next to `visual-pipeline.ts`, so the next
// behavioural frame kind is a row here, not another grep-for-branches hunt.
// ---------------------------------------------------------------------------

/**
 * How the Tester should approach a frame:
 *   - `exploratory` — a running system to probe (install/build, stand it up or target its
 *     provisioned env, exercise behaviour and edge cases). The service/frontend default.
 *   - `suite` — a published package with no running system: run the unit + integration
 *     suite, assess public-API coverage against the change, and author the missing tests.
 */
export type TestPosture = 'exploratory' | 'suite'

/** The capability flags a frame's behaviour derives from (see {@link frameProfile}). */
export interface FrameProfile {
  /**
   * The frame produces a deployable artifact and can have an ephemeral environment stood up.
   * `false` for a library (a published package is never deployed) ⇒ the deployer records a
   * clean no-op regardless of any declared provisioning, and the deployer-config /
   * deployer-before-consumer start gates pass through.
   */
  readonly deployable: boolean
  /**
   * The frame can be exercised as a running system (manual/exploratory testing against a live
   * instance). `false` for a library ⇒ the tester-infra start gate never demands a workspace
   * handler (the suite runs in-container).
   */
  readonly liveTestable: boolean
  /** The frame owns a rendered UI (a `frontend` app). */
  readonly hasUi: boolean
  /** The posture the Tester runs in on this frame (see {@link TestPosture}). */
  readonly testPosture: TestPosture
}

const LIBRARY_PROFILE: FrameProfile = {
  deployable: false,
  liveTestable: false,
  hasUi: false,
  testPosture: 'suite',
}

const FRONTEND_PROFILE: FrameProfile = {
  deployable: true,
  liveTestable: true,
  hasUi: true,
  testPosture: 'exploratory',
}

/** The default profile for a backend service (and every non-library, non-frontend block type). */
const SERVICE_PROFILE: FrameProfile = {
  deployable: true,
  liveTestable: true,
  hasUi: false,
  testPosture: 'exploratory',
}

/**
 * The capability profile for a frame's block `type`. Keyed off the full {@link BlockType} (a frame
 * can be `api`/`database`/… via other paths), so an unlisted type defaults to the `service` profile
 * — nothing changes for it. Only `library` (published package: no deploy/env, suite-focused tester)
 * and `frontend` (owns a UI) diverge from that default today; a future behavioural frame kind is a
 * new case here.
 */
export function frameProfile(type: BlockType | undefined | null): FrameProfile {
  switch (type) {
    case 'library':
      return LIBRARY_PROFILE
    case 'frontend':
      return FRONTEND_PROFILE
    default:
      return SERVICE_PROFILE
  }
}
