import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-workspace incident-enrichment connection. Moved out of the deployment-wide
// env vars (`PAGERDUTY_API_TOKEN` / `PAGERDUTY_FROM_EMAIL` / `INCIDENTIO_API_KEY`)
// onto a sealed per-workspace row so each workspace brings its own PagerDuty /
// incident.io credentials, configured in the UI. Both vendors live in ONE sealed
// blob (never one-table-per-secret). Secrets are write-only — never read back.
// Paired conceptually with the per-workspace observability connection.
// ---------------------------------------------------------------------------

/** PagerDuty enrichment credentials. */
export const pagerDutyCredentialsSchema = v.object({
  apiToken: v.pipe(v.string(), v.trim(), v.minLength(1)),
  /** The `From` email PagerDuty requires for note/annotation writes. */
  fromEmail: v.pipe(v.string(), v.trim(), v.email()),
})
export type PagerDutyCredentials = v.InferOutput<typeof pagerDutyCredentialsSchema>

/** incident.io enrichment credentials. */
export const incidentIoCredentialsSchema = v.object({
  apiKey: v.pipe(v.string(), v.trim(), v.minLength(1)),
})
export type IncidentIoCredentials = v.InferOutput<typeof incidentIoCredentialsSchema>

/**
 * The decrypted incident-enrichment credentials blob. Both providers optional —
 * a workspace may wire one, both, or (after a clear) neither.
 */
export const incidentEnrichmentCredentialsSchema = v.object({
  pagerDuty: v.optional(pagerDutyCredentialsSchema),
  incidentIo: v.optional(incidentIoCredentialsSchema),
})
export type IncidentEnrichmentCredentials = v.InferOutput<
  typeof incidentEnrichmentCredentialsSchema
>

/**
 * Validate a decrypted incident-enrichment blob at the read boundary, so a
 * drifted/hand-edited row fails with a clear schema error here rather than deep
 * inside the PagerDuty / incident.io client during a live enrichment.
 */
export function parseIncidentEnrichmentCredentials(raw: unknown): IncidentEnrichmentCredentials {
  return v.parse(incidentEnrichmentCredentialsSchema, raw)
}

/**
 * Set a workspace's incident-enrichment credentials (write-only). Each provider group is
 * three-state so an operator can edit one vendor without disturbing the other AND can
 * remove just one: OMITTED ⇒ leave the stored group unchanged, `null` ⇒ clear it, a value
 * ⇒ set it. (A full wipe of both is `DELETE`.) Mirrors the account-settings secrets merge.
 */
export const upsertIncidentEnrichmentSchema = v.object({
  pagerDuty: v.optional(v.nullable(pagerDutyCredentialsSchema)),
  incidentIo: v.optional(v.nullable(incidentIoCredentialsSchema)),
})
export type UpsertIncidentEnrichmentInput = v.InferOutput<typeof upsertIncidentEnrichmentSchema>

/** Non-secret presence flags persisted alongside the sealed blob, for the UI badge. */
export const incidentEnrichmentSummarySchema = v.object({
  pagerDuty: v.boolean(),
  incidentIo: v.boolean(),
})
export type IncidentEnrichmentSummary = v.InferOutput<typeof incidentEnrichmentSummarySchema>

/** What `GET /incident-enrichment` returns — never the secret tokens. */
export const incidentEnrichmentViewSchema = v.object({
  connected: v.boolean(),
  summary: v.nullable(incidentEnrichmentSummarySchema),
})
export type IncidentEnrichmentView = v.InferOutput<typeof incidentEnrichmentViewSchema>

/** Derive the non-secret summary from the credentials blob. */
export function incidentEnrichmentSummary(
  credentials: IncidentEnrichmentCredentials,
): IncidentEnrichmentSummary {
  return {
    pagerDuty: Boolean(credentials.pagerDuty),
    incidentIo: Boolean(credentials.incidentIo),
  }
}
