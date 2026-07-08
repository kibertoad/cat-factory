import {
  defineProviderToken,
  isProviderWired,
  wireProvider,
  type CiStatusProvider,
  type DocQualityProvider,
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
/** Token for the document structural-check source the `doc-quality` gate probes. */
export const DOC_QUALITY_PROVIDER = defineProviderToken<DocQualityProvider>('doc-quality')

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

/** Wire (or clear) the document structural-check source the `doc-quality` gate probes. */
export function wireDocQualityProvider(provider: DocQualityProvider | undefined): void {
  wireProvider(DOC_QUALITY_PROVIDER, provider)
}

/** Clear every built-in gate provider. Intended for tests. */
export function clearGateProviders(): void {
  for (const token of [
    CI_STATUS_PROVIDER,
    MERGEABILITY_PROVIDER,
    RELEASE_HEALTH_PROVIDER,
    INCIDENT_ENRICHMENT_PROVIDER,
    PULL_REQUEST_REVIEW_PROVIDER,
    DOC_QUALITY_PROVIDER,
  ] as ProviderToken<unknown>[]) {
    wireProvider(token, undefined)
  }
}

/** Minimal structured-logger shape (the facade's pino logger satisfies it). */
export interface GateWiringLogger {
  warn(obj: Record<string, unknown>, msg?: string): void
}

// Each built-in gate that, when its provider is UNWIRED, silently passes through — and
// what that pass-through actually means, so the warning names the operational risk.
const PASS_THROUGH_GATES: ReadonlyArray<{
  gate: string
  token: ProviderToken<unknown>
  effect: string
}> = [
  {
    gate: 'ci',
    token: CI_STATUS_PROVIDER,
    effect: 'CI is never checked — PRs advance as if green',
  },
  {
    gate: 'conflicts',
    token: MERGEABILITY_PROVIDER,
    effect: 'merge conflicts are never detected',
  },
  {
    gate: 'post-release-health',
    token: RELEASE_HEALTH_PROVIDER,
    effect: 'release regressions are never caught',
  },
  {
    gate: 'human-review',
    token: PULL_REQUEST_REVIEW_PROVIDER,
    effect: 'PR review approval is never required',
  },
  {
    gate: 'doc-quality',
    token: DOC_QUALITY_PROVIDER,
    effect: 'document structure is never checked',
  },
]

// Dedupe so a per-request container rebuild (Cloudflare) doesn't re-log every build:
// each gate is warned at most once per process.
const warnedGates = new Set<string>()

/**
 * Log (at WARN) every built-in gate whose provider is NOT wired — a pass-through gate is
 * otherwise indistinguishable from a genuinely green one, so a deployment that forgot to
 * configure the GitHub App would silently auto-merge without ever checking CI. Call once
 * per container build with the facade's logger; the warning fires at most once per gate
 * per process. Pass-through stays the behaviour — this only makes the misconfiguration
 * visible.
 */
export function warnUnwiredGates(log: GateWiringLogger): void {
  for (const { gate, token, effect } of PASS_THROUGH_GATES) {
    if (isProviderWired(token) || warnedGates.has(gate)) continue
    warnedGates.add(gate)
    log.warn(
      { gate, effect, passThrough: true },
      `gate '${gate}' has no provider wired — passing through (${effect})`,
    )
  }
}

/** The built-in gates' providers as one optional bag, for wiring through a build step. */
export interface GateProviderOverrides {
  ciStatus?: CiStatusProvider
  mergeability?: PullRequestMergeabilityProvider
  releaseHealth?: ReleaseHealthProvider
  incidentEnrichment?: IncidentEnrichmentProvider
  prReview?: PullRequestReviewProvider
  docQuality?: DocQualityProvider
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
  if (overrides.docQuality) wireDocQualityProvider(overrides.docQuality)
}
