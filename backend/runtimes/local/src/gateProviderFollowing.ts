import type { Logger, ProviderRegistry, ProviderToken } from '@cat-factory/kernel'
import {
  CI_STATUS_PROVIDER,
  DOC_QUALITY_PROVIDER,
  MERGEABILITY_PROVIDER,
  PULL_REQUEST_REVIEW_PROVIDER,
  warnUnwiredGates,
} from '@cat-factory/gates'

// Keeping the VCS-backed gate providers in step with what can actually answer them.
//
// Everywhere else, local mode's "no source control" state is resolved PER CALL. A gate is the one
// thing that cannot be: `wired()` is what decides whether the gate probes at all, and it is read
// off the provider registry the build populated. So this is the seam that re-derives that decision
// when the deployment's reach changes, and it lives beside `vcsCredential.ts` rather than inside
// the container assembly because getting it wrong is invisible in both directions (a deployment
// that fails every run, or one that advances PRs as if CI were green) and it is worth testing on
// its own.

/**
 * The built-in gate providers built FROM the VCS client. Each answers a question only source
 * control can answer, so each must be wired exactly while the deployment can reach it — see
 * {@link followVcsReachOnProviderRegistry}. (`release-health` and `incident-enrichment` are
 * Datadog-shaped and unrelated, so they are deliberately absent.)
 */
export const VCS_BACKED_GATE_PROVIDERS: readonly ProviderToken<unknown>[] = [
  CI_STATUS_PROVIDER,
  MERGEABILITY_PROVIDER,
  PULL_REQUEST_REVIEW_PROVIDER,
  DOC_QUALITY_PROVIDER,
]

/**
 * Make the VCS-backed gate providers follow whatever can currently answer them.
 *
 * A gate probes iff its provider is wired, and local mode hands the build a VCS client that ALWAYS
 * exists (so that "no token" can be a refusal naming the fix rather than an absent client the
 * layers above read as "this deployment does no source control"). The build therefore wires all
 * four regardless. That is right the moment the client can reach a host and wrong before it: a
 * deployment reaching nothing would probe CI with nothing to ask and fail runs whose documented
 * behaviour is to pass through. So the impls the build produced are captured once and re-wired (or
 * cleared) as the answer changes. This decides only WHETHER they are wired; the impls are the
 * build's own, verbatim.
 *
 * `canReach` is the SAME question the client router and `mintInstallationToken` ask, and it is
 * deliberately NOT just "is there a credential": a mothership node reaches GitHub on installation
 * tokens the mothership mints, holding no local PAT at all, and backing gates/merge is one of the
 * things that delegation exists for. Keyed on the credential alone, every mothership run would
 * advance as if CI were green.
 *
 * `warnUnwiredGates` runs on a TRANSITION to unwired, because the build's own call saw them wired
 * and therefore said nothing — and "CI is never checked, PRs advance as if green" is exactly what
 * an operator must hear. Only on the transition, so a re-apply doesn't reprint the unrelated
 * advisories the build already logged.
 */
export function followVcsReachOnProviderRegistry(params: {
  registry: ProviderRegistry
  canReach: () => boolean
  /** Register a callback fired whenever the answer to {@link canReach} may have changed. */
  onChange: (fn: () => void) => void
  logger: Logger
}): void {
  const { registry, canReach, onChange, logger } = params
  const built = new Map(VCS_BACKED_GATE_PROVIDERS.map((token) => [token, registry.get(token)]))
  let wired: boolean | undefined
  const apply = () => {
    const reachable = canReach()
    for (const token of VCS_BACKED_GATE_PROVIDERS) {
      registry.wire(token, reachable ? built.get(token) : undefined)
    }
    if (!reachable && wired !== false) warnUnwiredGates(registry, logger)
    wired = reachable
  }
  apply()
  onChange(apply)
}
