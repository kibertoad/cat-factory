import { defineApiContract } from '@toad-contracts/valibot'
import { prVerificationReportSchema } from '../pr-report.js'
import { publicRunArtifactListSchema } from '../public-evidence.js'
import { runOutcomeSchema } from '../run-outcome.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public run-EVIDENCE surface: absolute `/api/v1` paths,
// authenticated in-controller by a public-API key at `read` scope. The wire shapes and the
// reasoning behind them live in `../public-evidence.ts`.
//
// The two reads here are addressed under `/api/v1/runs/:runId/*`, beside the parked-decision
// routes rather than under `/api/v1/debug/*`, and that is a statement about what they are: a
// run's evidence is the thing a consumer ACTS on (accept the change, score the run), where the
// debug surface is what someone reads when a run went wrong. They are workspace-scoped like the
// debug reads, though. See `PublicEvidenceController` for why the narrower decision scope
// would be the wrong reach for a consumer whose job is auditing a board.
//
// The BYTES (`GET /api/v1/artifacts/:artifactId/blob`) are deliberately not a contract: the
// response is an image, not JSON, so it is a hand-mounted Hono route documented by hand in
// `scripts/generate-openapi.mjs`, the same treatment the two SSE endpoints get.
// ---------------------------------------------------------------------------

const runIdParams = singleStringParam('runId')

/**
 * The run's verification report: the engine's bundle of captured facts, byte-for-byte what it
 * maintains on the pull request, composed on read from the run's persisted state.
 *
 * A consumer that scraped the fenced JSON block out of a PR body can read it here instead, and
 * gets it for the runs that never opened a pull request at all.
 */
export const getPublicRunReportContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/report`,
  responsesByStatusCode: { 200: prVerificationReportSchema, ...errorResponses },
})

/**
 * The run's OUTCOME summary: what it changed and what backs that up, for a reader who will not
 * open the diff.
 *
 * The sibling of the report above rather than a projection of it, and the difference is the
 * AUDIENCE, not the facts: the report is a reviewer's evidence bundle (every failing check by
 * name, every captured log tail, the merge assessment), this is the product-language answer the
 * app's outcome card renders, and the counts underneath both are computed by the same shared
 * rules. A consumer deciding whether a change is acceptable wants the report; one reporting to a
 * person what shipped wants this.
 *
 * Deliberately not derived from the report on the wire: the report is BOUNDED to what fits in a
 * pull-request body, and a tally taken off its capped tables would be quietly wrong.
 */
export const getPublicRunOutcomeContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/outcome`,
  responsesByStatusCode: { 200: runOutcomeSchema, ...errorResponses },
})

/** The binary artifacts the run captured (metadata; the bytes are a second, per-artifact fetch). */
export const listPublicRunArtifactsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: runIdParams,
  pathResolver: ({ runId }) => `/api/v1/runs/${runId}/artifacts`,
  responsesByStatusCode: { 200: publicRunArtifactListSchema, ...errorResponses },
})
