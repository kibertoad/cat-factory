import { defineApiContract } from '@toad-contracts/valibot'
import { tagReviewEffortSchema } from '../mergeTrackRecord.js'
import {
  publicMergeClassRollupListSchema,
  publicMergeRecordSchema,
} from '../public-merge-evidence.js'
import { errorResponses, singleStringParam, withMinScope } from './_shared.js'

// ---------------------------------------------------------------------------
// Route contracts for the public MERGE-EVIDENCE surface: absolute `/api/v1` paths,
// authenticated in-controller by a public-API key. The wire shapes and the reasoning behind
// them live in `../public-merge-evidence.ts`; the feature itself is
// `backend/docs/adr/0046-merge-track-record.md`.
//
// The scope split is the whole point of the surface, and it is deliberately NOT the one `act`
// carries. `POST /api/v1/notifications/:id/act` is `admin` because it MERGES a pull request for
// real; TAGGING how much review an already-landed pull request needed performs no external
// side-effect and cannot merge anything, so it is `write`, and the reads are `read` like every
// other read on this API. An integration that watches a board and records review effort
// therefore needs neither merge rights nor the ability to delete a task, where before the only
// way to record a tag at all was through the `admin`-scoped `act`.
//
// The two workspace-scoped point routes are addressed by RECORD id and re-apply the key's
// workspace to the row they load, which is the rule every point read on this API follows
// (`/api/v1/debug/llm-calls/:callId`, `/api/v1/artifacts/:artifactId/blob`). The run-scoped read
// is under `/api/v1/runs/:runId/*` and therefore carries that prefix's ONE access semantic
// instead: a run this key could already reach through `GET /jobs/:id` or
// `GET /tasks/:taskId/run`. See `PublicEvidenceController` for why a prefix may carry only one.
// ---------------------------------------------------------------------------

const runIdParams = singleStringParam('runId')
const recordIdParams = singleStringParam('recordId')

/**
 * The merge decision a RUN left behind: its change class, the merger's scores, what happened,
 * and the effort tag if one has been recorded.
 *
 * The entry point of the loop for a caller that started the run and holds its id, and the read
 * that hands it the `recordId` the tag route takes. A run whose pipeline had no `merger` step
 * (or whose merge path never got far enough to classify) has no record, and that is a `404`
 * rather than an empty object: "this run made no merge decision" is a fact about the run.
 */
export const getPublicRunMergeRecordContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: runIdParams,
    pathResolver: ({ runId }) => `/api/v1/runs/${runId}/merge-record`,
    responsesByStatusCode: { 200: publicMergeRecordSchema, ...errorResponses },
  }),
)

/**
 * Every change class's accumulated track record for the key's workspace, as ONE aggregate.
 *
 * Registered ahead of the point read below so `rollups` cannot be taken for a record id. It
 * cannot be one today (record ids are `mtr_*`), but the ordering is what keeps that true of a
 * future id scheme rather than of this one.
 */
export const listPublicMergeClassRollupsContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    pathResolver: () => '/api/v1/merge-records/rollups',
    responsesByStatusCode: { 200: publicMergeClassRollupListSchema, ...errorResponses },
  }),
)

/**
 * One record by id: the read-back beside the tag write, so a caller holding a `recordId` (from
 * a `merge_tag_request` card's payload, say) can see WHAT it is about to tag rather than tagging
 * an opaque id.
 */
export const getPublicMergeRecordContract = withMinScope(
  'read',
  defineApiContract({
    method: 'get',
    requestPathParamsSchema: recordIdParams,
    pathResolver: ({ recordId }) => `/api/v1/merge-records/${recordId}`,
    responsesByStatusCode: { 200: publicMergeRecordSchema, ...errorResponses },
  }),
)

/**
 * Tag (or clear, with `null`) the reviewer effort a human spent on the pull request a record
 * covers. `write`, not `admin`: this records evidence about a decision that already happened.
 *
 * Idempotent (the same tag applied twice leaves the same row) and orthogonal to the decision, so
 * a record may be tagged whenever the effort becomes known, including long after the merge.
 */
export const tagPublicMergeReviewEffortContract = withMinScope(
  'write',
  defineApiContract({
    method: 'post',
    requestPathParamsSchema: recordIdParams,
    pathResolver: ({ recordId }) => `/api/v1/merge-records/${recordId}/effort`,
    requestBodySchema: tagReviewEffortSchema,
    responsesByStatusCode: { 200: publicMergeRecordSchema, ...errorResponses },
  }),
)
