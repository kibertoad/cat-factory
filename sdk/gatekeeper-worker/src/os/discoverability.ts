// Whether a Cloudflare OS deployment could discover and install this Gatekeeper, as a REPORT.
//
// Two things have to be true and neither has a request path of its own: the entry module must
// carry the four exports the object model resolves by name, and the policy must name an
// `autoProvisionedTier`, since every account this door mints falls to it. A workspace that finds
// either missing does not get an error anyone monitors; it simply never finishes installing.
//
// It is a report rather than a refusal because a Gatekeeper serving `/rpc` and nothing else is a
// SUPPORTED deployment, not a broken one: the HTTP door is what a consumer that is not a
// Cloudflare OS speaks, and this package promises to go on serving it. Turning that deployment's
// liveness red the day it takes a version bump would be this check answering a question nobody
// asked it, which is the same failure as the health route that reported only the bindings its
// request path happened to read: a monitor saying something the operator cannot act on.
//
// So the two facts are reported side by side, each naming its own remedy, and a deployment that
// wants discovery keys a monitor on `os.discoverable` while one that does not ignores it.

import { missingOsExports, OS_EXPORTS } from './exports.js'

/** Why a Cloudflare OS deployment could not finish installing this Gatekeeper. */
export type DiscoveryBlockerReason = 'missing_exports' | 'no_auto_provisioned_tier'

/** One thing standing between this Worker and a workspace that could use it. */
export interface DiscoveryBlocker {
  reason: DiscoveryBlockerReason
  detail: string
}

/**
 * What `/health` says about the Cloudflare OS door, beside what it says about liveness.
 *
 * `discoverable` is derived from `blockers` rather than reported alongside it, so the two cannot
 * disagree.
 */
export interface DiscoverabilityReport {
  discoverable: boolean
  blockers: DiscoveryBlocker[]
}

/**
 * Ask both questions in ONE pass.
 *
 * The same rule the binding check follows: an operator who learns the next missing piece only
 * after redeploying wires a deployment one restart at a time.
 */
export function describeDiscoverability(deps: {
  /** The Worker's own exports, as the object model reaches them (`ctx.exports`). */
  exports: unknown
  /** The tier name the policy nominates for auto-provisioned accounts, or `null`. */
  autoProvisionedTier: string | null
}): DiscoverabilityReport {
  const blockers: DiscoveryBlocker[] = []

  const missing = missingOsExports(deps.exports)
  if (missing.length > 0) {
    blockers.push({
      reason: 'missing_exports',
      detail:
        `This Worker's entry module does not export ${missing.map((role) => OS_EXPORTS[role]).join(', ')}. ` +
        'The Cloudflare OS object model resolves each by name against this Worker ' +
        '(deploy/gatekeeper/src/index.ts is the template).',
    })
  }

  if (deps.autoProvisionedTier === null) {
    blockers.push({
      reason: 'no_auto_provisioned_tier',
      detail:
        "This deployment's policy names no autoProvisionedTier, so a workspace can discover this " +
        'Gatekeeper and never open a session through it: an account minted by the object model ' +
        'carries no identity a grants entry could match, and every one falls to that tier. It is ' +
        'deliberately separate from defaultTier, which governs the /rpc door.',
    })
  }

  return { discoverable: blockers.length === 0, blockers }
}
