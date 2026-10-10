import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { preflightRefSchema, preflightResultSchema } from '../preflights.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Preflight route contract. Mounted under `/workspaces/:workspaceId`, so the
// path here is relative to that prefix. One action: run a set of preflight
// checks and return their verdicts (for the setup wizard's live re-check button
// — slice 7 — and any ad-hoc "am I ready to provision?" probe). The checks run
// only on the local (host) facade; elsewhere the controller 503s. See
// PreflightController in @cat-factory/server.
// ---------------------------------------------------------------------------

const runPreflightsRequestSchema = v.object({
  prerequisites: v.array(preflightRefSchema),
})

/**
 * Run the given preflight checks and return one {@link preflightResultSchema} per ref (pass / fail /
 * warn + a probe detail + remediation on a non-pass). Requires the host-probe runtime (local
 * facade); 503 otherwise.
 */
export const runPreflightsContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/preflights/run',
  requestBodySchema: runPreflightsRequestSchema,
  responsesByStatusCode: { 200: v.array(preflightResultSchema), ...errorResponses },
})
