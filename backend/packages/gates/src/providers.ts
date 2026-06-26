import type {
  CiStatusProvider,
  IncidentEnrichmentProvider,
  PullRequestMergeabilityProvider,
  ReleaseHealthProvider,
} from '@cat-factory/kernel'

// The data sources the built-in gates probe are module-level handles a deployment wires at
// startup (exactly like a custom gate wires its own provider — see
// `@cat-factory/example-custom-agent`'s `wireLicenseProvider`). The gate factories close
// over these; until a provider is wired its gate is a harmless pass-through (`wired()`
// returns false), so a bare `import '@cat-factory/gates'` is always safe.
//
// This is the whole point of the externalization: the engine no longer holds these
// providers. A facade constructs its impl (GitHubCiStatusProvider, RegistryReleaseHealth…)
// and hands it here, instead of threading it through the engine's constructor.

let ciStatusProvider: CiStatusProvider | undefined
let mergeabilityProvider: PullRequestMergeabilityProvider | undefined
let releaseHealthProvider: ReleaseHealthProvider | undefined
let incidentEnrichment: IncidentEnrichmentProvider | undefined

/** Wire (or clear, with `undefined`) the CI check-runs source the `ci` gate probes. */
export function wireCiStatusProvider(provider: CiStatusProvider | undefined): void {
  ciStatusProvider = provider
}

/** Wire (or clear) the PR-mergeability source the `conflicts` gate probes. */
export function wireMergeabilityProvider(
  provider: PullRequestMergeabilityProvider | undefined,
): void {
  mergeabilityProvider = provider
}

/** Wire (or clear) the release-health source the `post-release-health` gate probes. */
export function wireReleaseHealthProvider(provider: ReleaseHealthProvider | undefined): void {
  releaseHealthProvider = provider
}

/** Wire (or clear) the incident-enrichment source the on-call escalation annotates. */
export function wireIncidentEnrichment(provider: IncidentEnrichmentProvider | undefined): void {
  incidentEnrichment = provider
}

// Internal accessors the gate factories read at probe time (after startup wiring).
export const getCiStatusProvider = (): CiStatusProvider | undefined => ciStatusProvider
export const getMergeabilityProvider = (): PullRequestMergeabilityProvider | undefined =>
  mergeabilityProvider
export const getReleaseHealthProvider = (): ReleaseHealthProvider | undefined =>
  releaseHealthProvider
export const getIncidentEnrichment = (): IncidentEnrichmentProvider | undefined =>
  incidentEnrichment

/** Clear every wired provider. Intended for tests that exercise the gates in isolation. */
export function clearGateProviders(): void {
  ciStatusProvider = undefined
  mergeabilityProvider = undefined
  releaseHealthProvider = undefined
  incidentEnrichment = undefined
}

/** The built-in gates' providers as one optional bag, for wiring through a build step. */
export interface GateProviderOverrides {
  ciStatus?: CiStatusProvider
  mergeability?: PullRequestMergeabilityProvider
  releaseHealth?: ReleaseHealthProvider
  incidentEnrichment?: IncidentEnrichmentProvider
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
}
