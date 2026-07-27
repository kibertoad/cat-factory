import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  mergeClassRollupSchema,
  mergeTrackRecordSchema,
  tagReviewEffortSchema,
} from '../mergeTrackRecord.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Merge track record route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See MergeTrackRecordController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const recordIdParams = singleStringParam('recordId')

/**
 * Per-change-class rollups for the workspace — ONE request returns every class, computed as a
 * single SQL aggregate (`GROUP BY change_class` + conditional `SUM`s). The preset editor renders
 * each class's rule next to these numbers, so it must never fan out one request per class.
 */
export const listMergeClassRollupsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/merge-track-records/rollups',
  responsesByStatusCode: { 200: v.array(mergeClassRollupSchema), ...errorResponses },
})

/**
 * Tag (or clear) the reviewer effort a human spent on a merged pull request. Deliberately a
 * standalone route as well as an `act`-body field: an external merge (or the inspector's merge
 * control) needs to tag a record with no notification act in flight.
 */
export const tagMergeReviewEffortContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: recordIdParams,
  pathResolver: ({ recordId }) => `/merge-track-records/${recordId}/effort`,
  requestBodySchema: tagReviewEffortSchema,
  responsesByStatusCode: { 200: mergeTrackRecordSchema, ...errorResponses },
})
