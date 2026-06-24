import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Post-release-health wire contracts. After a release deploys, the
// `post-release-health` gate watches the team's Datadog monitors/SLOs over a
// monitoring window. On a regression it dispatches the `on-call` agent, which
// reasons over an evidence bundle + the released PR diff and returns this
// structured assessment (it makes NO commits and reverts nothing). The engine
// then raises a `release_regression` notification carrying the assessment + the
// regressed signals for a human to act on (revert / acknowledge).
// ---------------------------------------------------------------------------

/** One monitored signal (a Datadog monitor or SLO), flattened to its current state. */
export const releaseSignalSchema = v.object({
  kind: v.picklist(['monitor', 'slo']),
  id: v.string(),
  name: v.string(),
  state: v.picklist(['ok', 'warn', 'alert', 'no_data']),
  detail: v.optional(v.string()),
})
export type ReleaseSignalWire = v.InferOutput<typeof releaseSignalSchema>

/** What the on-call agent recommends doing about the regression. */
export const onCallRecommendationSchema = v.picklist(['revert', 'hold', 'monitor'])
export type OnCallRecommendation = v.InferOutput<typeof onCallRecommendationSchema>

/**
 * The `on-call` agent's structured assessment of a release regression. `culpritConfidence`
 * (0..1) is how strongly the evidence points at THIS PR as the cause; `recommendation`
 * is the suggested human action; `evidence` lists the concrete observations behind it.
 */
export const onCallAssessmentSchema = v.object({
  /** How confident the agent is that the released PR caused the regression (0..1). */
  culpritConfidence: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** The recommended human action. */
  recommendation: onCallRecommendationSchema,
  /** Plain-prose justification. */
  rationale: v.string(),
  /** Concrete observations behind the verdict (log lines, correlations, diff hunks). */
  evidence: v.optional(v.array(v.string()), []),
})
export type OnCallAssessment = v.InferOutput<typeof onCallAssessmentSchema>

/** Parse-or-throw an on-call assessment payload the agent returned. */
export function parseOnCallAssessment(value: unknown): OnCallAssessment {
  return v.parse(onCallAssessmentSchema, value)
}

// ---- Observability connection (per-workspace) -----------------------------
// The post-release-health gate reads a pluggable observability provider. Datadog is
// the only adapter today; the connection is keyed by `provider` so a second vendor is
// just a new adapter + credential shape (switch `credentials` to a discriminated
// variant then). Keys are write-only — never read back.

/** Observability vendors a workspace can connect (extensible). */
export const observabilityProviderKindSchema = v.picklist(['datadog'])
export type ObservabilityProviderKind = v.InferOutput<typeof observabilityProviderKindSchema>

/** Datadog site host the connection points at. */
const datadogSiteSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))

/** Provider-specific credentials. Today only Datadog (`site` + API/app keys). */
export const datadogCredentialsSchema = v.object({
  site: datadogSiteSchema,
  apiKey: v.pipe(v.string(), v.trim(), v.minLength(1)),
  appKey: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type DatadogCredentials = v.InferOutput<typeof datadogCredentialsSchema>

/**
 * Validate a decrypted Datadog credentials blob at the read boundary. The provider
 * registry calls this on the JSON it decrypts so a drifted/corrupted/hand-edited row
 * fails with a clear schema error here, rather than deep inside the Datadog client
 * during a live post-release probe.
 */
export function parseDatadogCredentials(raw: unknown): DatadogCredentials {
  return v.parse(datadogCredentialsSchema, raw)
}

/** Set/replace the workspace's observability connection (credentials write-only). */
export const upsertObservabilityConnectionSchema = v.object({
  provider: observabilityProviderKindSchema,
  credentials: datadogCredentialsSchema,
})
export type UpsertObservabilityConnectionInput = v.InferOutput<
  typeof upsertObservabilityConnectionSchema
>

/** What `GET /observability/connection` returns — never the secret keys. */
export const observabilityConnectionViewSchema = v.object({
  connected: v.boolean(),
  provider: v.nullable(observabilityProviderKindSchema),
  /** Non-secret display fields, e.g. `{ site }` for Datadog. */
  summary: v.nullable(v.record(v.string(), v.string())),
})
export type ObservabilityConnectionView = v.InferOutput<typeof observabilityConnectionViewSchema>

/**
 * The non-secret display summary persisted alongside the sealed credentials, so the
 * connection view can show provider context without ever decrypting the secret.
 */
export function observabilityConnectionSummary(
  provider: ObservabilityProviderKind,
  credentials: UpsertObservabilityConnectionInput['credentials'],
): Record<string, string> {
  switch (provider) {
    case 'datadog':
      return { site: credentials.site }
  }
}

// ---- Release-health config (per repo/service block) -----------------------

/** A block's monitor/SLO mapping for the post-release-health gate. */
export const releaseHealthConfigSchema = v.object({
  blockId: v.string(),
  monitorIds: v.array(v.string()),
  sloIds: v.array(v.string()),
  envTag: v.nullable(v.string()),
})
export type ReleaseHealthConfigWire = v.InferOutput<typeof releaseHealthConfigSchema>

/**
 * A Datadog env tag value. Constrained to the characters a real env/tag value uses so it
 * can be interpolated into a Datadog log query (`status:error env:<tag>`) without spaces
 * or query metacharacters (`* ( ) :` and whitespace) that would silently broaden or break
 * the query — and silently empty the on-call evidence bundle.
 */
const envTagSchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(
    /^[A-Za-z0-9_.\-/]+$/,
    'envTag may only contain letters, digits and _.-/ (no spaces or query characters)',
  ),
)

/** Create/replace a block's release-health config. */
export const upsertReleaseHealthConfigSchema = v.object({
  monitorIds: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))), []),
  sloIds: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))), []),
  envTag: v.optional(v.nullable(envTagSchema)),
})
export type UpsertReleaseHealthConfigInput = v.InferOutput<typeof upsertReleaseHealthConfigSchema>
