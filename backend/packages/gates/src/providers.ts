import {
  defineProviderToken,
  isProviderWired,
  wireProvider,
  type CiStatusProvider,
  type IncidentEnrichmentProvider,
  type ProviderToken,
  type PullRequestMergeabilityProvider,
  type PullRequestReviewProvider,
  type ReleaseHealthProvider,
} from '@cat-factory/kernel'

// The data sources the built-in gates probe are wired into the typed kernel provider
// registry at startup (exactly like a custom gate wires its own provider — see
// `@cat-factory/example-custom-agent`'s `LICENSE_PROVIDER`). The gates read them back through
// their `GateContext` (`ctx.getProvider`/`ctx.requireProvider`); until a provider is wired its
// gate is a harmless pass-through (`wired()` returns false), so a bare `import
// '@cat-factory/gates'` is always safe.
//
// This is the whole point of the externalization: the engine no longer holds these
// providers. A facade constructs its impl (GitHubCiStatusProvider, RegistryReleaseHealth…)
// and hands it here, instead of threading it through the engine's constructor. The
// `wireX`/`clearGateProviders`/`applyGateProviders` public surface is unchanged — only the
// storage moved from four module-level `let`s to the shared token registry.

/** Token for the CI check-runs source the `ci` gate probes. */
export const CI_STATUS_PROVIDER = defineProviderToken<CiStatusProvider>('ci-status')
/** Token for the PR-mergeability source the `conflicts` gate probes. */
export const MERGEABILITY_PROVIDER =
  defineProviderToken<PullRequestMergeabilityProvider>('mergeability')
/** Token for the release-health source the `post-release-health` gate probes. */
export const RELEASE_HEALTH_PROVIDER = defineProviderToken<ReleaseHealthProvider>('release-health')
/** Token for the incident-enrichment source the on-call escalation annotates. */
export const INCIDENT_ENRICHMENT_PROVIDER =
  defineProviderToken<IncidentEnrichmentProvider>('incident-enrichment')
/** Token for the PR-review source the `human-review` gate probes (approval + threads). */
export const PULL_REQUEST_REVIEW_PROVIDER =
  defineProviderToken<PullRequestReviewProvider>('pr-review')

/** Wire (or clear, with `undefined`) the CI check-runs source the `ci` gate probes. */
export function wireCiStatusProvider(provider: CiStatusProvider | undefined): void {
  wireProvider(CI_STATUS_PROVIDER, provider)
}

/** Wire (or clear) the PR-mergeability source the `conflicts` gate probes. */
export function wireMergeabilityProvider(
  provider: PullRequestMergeabilityProvider | undefined,
): void {
  wireProvider(MERGEABILITY_PROVIDER, provider)
}

/** Wire (or clear) the release-health source the `post-release-health` gate probes. */
export function wireReleaseHealthProvider(provider: ReleaseHealthProvider | undefined): void {
  wireProvider(RELEASE_HEALTH_PROVIDER, provider)
}

/** Wire (or clear) the incident-enrichment source the on-call escalation annotates. */
export function wireIncidentEnrichment(provider: IncidentEnrichmentProvider | undefined): void {
  wireProvider(INCIDENT_ENRICHMENT_PROVIDER, provider)
}

/** Wire (or clear) the PR-review source the `human-review` gate probes. */
export function wirePullRequestReviewProvider(
  provider: PullRequestReviewProvider | undefined,
): void {
  wireProvider(PULL_REQUEST_REVIEW_PROVIDER, provider)
}

/** Clear every built-in gate provider (the four tokens above). Intended for tests. */
export function clearGateProviders(): void {
  for (const token of [
    CI_STATUS_PROVIDER,
    MERGEABILITY_PROVIDER,
    RELEASE_HEALTH_PROVIDER,
    INCIDENT_ENRICHMENT_PROVIDER,
    PULL_REQUEST_REVIEW_PROVIDER,
  ] as ProviderToken<unknown>[]) {
    wireProvider(token, undefined)
  }
}

/** Whether the CI status provider is wired (the `ci` gate's `wired()`). */
export const isCiStatusProviderWired = (): boolean => isProviderWired(CI_STATUS_PROVIDER)

/** The built-in gates' providers as one optional bag, for wiring through a build step. */
export interface GateProviderOverrides {
  ciStatus?: CiStatusProvider
  mergeability?: PullRequestMergeabilityProvider
  releaseHealth?: ReleaseHealthProvider
  incidentEnrichment?: IncidentEnrichmentProvider
  prReview?: PullRequestReviewProvider
}

/**
 * Wire any provided gate providers (leaving the rest untouched). A facade build runs
 * `clearGateProviders()` then re-wires from its config; this is the seam by which a test
 * (or an embedder) injects fake/explicit providers through that same per-build wiring, so
 * they survive a per-request container rebuild instead of being cleared. Only keys present
 * are wired — absent keys are left as the build's config wired them.
 */
export function applyGateProviders(overrides: GateProviderOverrides | undefined): void {
  if (!overrides) return
  if (overrides.ciStatus) wireCiStatusProvider(overrides.ciStatus)
  if (overrides.mergeability) wireMergeabilityProvider(overrides.mergeability)
  if (overrides.releaseHealth) wireReleaseHealthProvider(overrides.releaseHealth)
  if (overrides.incidentEnrichment) wireIncidentEnrichment(overrides.incidentEnrichment)
  if (overrides.prReview) wirePullRequestReviewProvider(overrides.prReview)
}
