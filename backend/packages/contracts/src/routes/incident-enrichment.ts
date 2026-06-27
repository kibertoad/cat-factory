import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import {
  incidentEnrichmentViewSchema,
  upsertIncidentEnrichmentSchema,
} from '../incident-enrichment.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace incident-enrichment route contracts (PagerDuty + incident.io).
// Mounted under `/workspaces/:workspaceId`, so the paths here are relative to
// that prefix. Credentials are write-only — GET returns only a presence summary.
// See IncidentEnrichmentController.
// ---------------------------------------------------------------------------

export const getIncidentEnrichmentContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/incident-enrichment',
  responsesByStatusCode: { 200: incidentEnrichmentViewSchema, ...errorResponses },
})

export const setIncidentEnrichmentContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/incident-enrichment',
  requestBodySchema: upsertIncidentEnrichmentSchema,
  responsesByStatusCode: { 200: incidentEnrichmentViewSchema, ...errorResponses },
})

export const deleteIncidentEnrichmentContract = defineApiContract({
  method: 'delete',
  pathResolver: () => '/incident-enrichment',
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})
