import type { EnvironmentFailureReason } from './types.js'
import { UnavailableError } from './errors.js'

// ---------------------------------------------------------------------------
// The PROVIDER-NEUTRAL half of environment-failure classification: what any environment
// provider — the built-in Kubernetes / compose / Cloudflare backends, and equally a backend a
// deployment registers into `EnvironmentBackendRegistry` — uses to say WHY a provision failed in
// a way the engine can act on.
//
// It lives in kernel rather than beside the Kubernetes provider precisely because a custom
// backend must be able to participate. The engine's remediation decision ("may an automated fixer
// be dispatched at this failure?") is keyed off `EnvironmentFailureReason`, so a provider that
// cannot state a reason gets the safe answer (never fixable) and is silently excluded from the
// mechanism. Giving it the same helpers the built-ins use is what makes the classification an
// extension point instead of a Kubernetes-only feature.
//
// A custom provider participates by doing one of two things, both optional and both degrading
// safely, and WHICH one is decided by how it reports the failure rather than by preference:
//   1. a provider that THROWS raises {@link environmentFailure} (or any `DomainError` carrying
//      `details.reason`) instead of a bare `Error`, so the engine reads the class off the error
//      rather than out of the prose;
//   2. a provider that instead returns `status: 'failed'` (a deterministic rejection it did not
//      consider exceptional, and the shape every container-backed provision settles into) has no
//      error to carry a reason, so it states one on `ProvisionedEnvironment.reason`. The engine
//      threads that alongside the handle to the same decision the thrown reason reaches.
// A provider that does neither behaves exactly as every provider did before this existed: its
// failures are unclassified, and unclassified is never repo-fixable.
// ---------------------------------------------------------------------------

/**
 * A provisioning failure carrying its machine-readable cause.
 *
 * `UnavailableError` for every class, including the manifest one, because `code` is the STATUS
 * CLASS and the answer is uniformly "this environment could not be stood up"; the cause that
 * differs is `details.reason`. That is the split the domain-error vocabulary asks for, and it is
 * why there is no per-cause error class to choose between.
 *
 * An unclassified failure carries NO reason rather than a null one, so no reader can mistake
 * "this was not classified" for a classification. That distinction is load-bearing: unclassified
 * is not repo-fixable, and a provider that has not adopted this must never be read as having
 * asserted something about its failures.
 */
export function environmentFailure(
  message: string,
  reason: EnvironmentFailureReason | null | undefined,
): UnavailableError {
  return new UnavailableError(message, reason ?? undefined)
}

/**
 * A `{{placeholder}}` a provider's templated inputs reference but cannot fill.
 *
 * Every built-in provider renders its manifests/compose files through the same lenient
 * substitution, where an unknown key resolves to the empty string. That leniency is deliberate (a
 * template may carry an optional value) and it is also how a correct file becomes an invalid one:
 * `image: "{{image}}"` renders to `image: ""`, and the platform it is submitted to then reports a
 * required field missing on a document whose source says nothing of the kind.
 */
export interface UnresolvedPlaceholder {
  /** The placeholder key as written, without braces. */
  key: string
  /**
   * The connection/handler field an operator sets to supply it, for a key the PLATFORM derives
   * from configuration rather than from the run. Absent for a key nothing known fills, which is a
   * template referencing something that was never going to exist and reads differently to whoever
   * has to fix it.
   */
  configField?: string
}

/**
 * The placeholders `text` references that `vars` cannot fill, deduplicated and in order of first
 * appearance.
 *
 * Scans the SOURCE, before substitution, because afterwards the evidence is gone: an empty string
 * in a rendered file is indistinguishable from an empty string its author wrote. A key that is
 * PRESENT but empty counts as unresolved too, since an operator who set the supplying field to a
 * blank string has supplied nothing and the file breaks identically.
 *
 * `configFields` maps a placeholder key to the setting that supplies it, and is the provider's to
 * pass because only the provider knows its own configuration shape (Kubernetes fills `{{image}}`
 * from `imageTemplate`; another backend may fill it from something else, or not at all). Keys the
 * RUN supplies (`blockId`, `branch`, `pullNumber`, …) are deliberately left out of that map: one
 * of those rendering empty is a fact about the run, and naming a config field for it would send an
 * operator to a setting that would not have helped.
 */
export function unresolvedPlaceholders(
  text: string,
  vars: Record<string, string>,
  configFields: Record<string, string> = {},
): UnresolvedPlaceholder[] {
  const found = new Map<string, UnresolvedPlaceholder>()
  // The same pattern the providers substitute with, so the two cannot disagree about what counts
  // as a placeholder.
  for (const match of text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
    const key = match[1]!
    if (found.has(key)) continue
    if ((vars[key] ?? '') !== '') continue
    const configField = configFields[key]
    found.set(key, { key, ...(configField ? { configField } : {}) })
  }
  return [...found.values()]
}

/**
 * The operator-facing refusal for a template the deployment's own CONFIGURATION cannot fill, or
 * `null` when there is nothing an operator could set.
 *
 * Refusing BEFORE submitting is the whole point, and providers should call this rather than
 * rendering empties and letting the platform reject them. The rejection that comes back describes
 * the RESULT and blames the file, which is how a correct `image: "{{image}}"` was reported as a
 * Deployment missing a required image. This names the placeholder, names the field that fills it,
 * and says the repository is not at fault, none of which the platform being deployed to could
 * ever have told anyone.
 *
 * SCOPED to the keys carrying a `configField`, and that scope is the refusal's whole justification
 * rather than a detail of it. A config-backed key is unambiguous: the platform undertook to supply
 * the value, the deployment has not been told how, and the message can name the setting to change.
 * Everything else unresolved is a key the RUN supplies, where absent and empty are the same value
 * and opposite facts: `frontendOrigins` is absent for a service no frontend binds, `peerEnvUrls`
 * for the first frame of a fan-out, `branch` and `pullNumber` for a peer frame that carries no PR
 * context. Each renders empty on purpose, so a template that folds one into a CORS list or a label
 * is CORRECT and refusing it would fail a provision naming no setting anyone could fix. The
 * lenient substitution stays the documented behaviour there; only the class an operator can act on
 * is worth stopping a deployment for.
 */
export function describeUnfilledConfigPlaceholders(
  missing: UnresolvedPlaceholder[],
): string | null {
  const blocking = missing.filter((m) => m.configField)
  if (blocking.length === 0) return null
  const items = blocking.map(
    (m) =>
      `'{{${m.key}}}' (supplied by this environment connection's '${m.configField}' setting, which is not set)`,
  )
  return (
    `The deployment files could not be rendered: ${items.join('; ')}. ` +
    'The repository is not at fault here and editing these files is the wrong fix: the ' +
    'placeholder exists so the value can vary per environment, and hard-coding it would defeat ' +
    'that. Set the missing configuration on the environment connection and retry.'
  )
}
