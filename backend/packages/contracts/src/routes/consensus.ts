import { defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { consensusSessionSchema } from '../consensus.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Read-only consensus route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. The single route loads the most
// recent consensus session for a block; it always 200s with `{ session: null }`
// when consensus is off or no session has run. See ConsensusController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const blockIdParams = singleStringParam('blockId')

/** The `{ session }` envelope the read route returns (session null when none). */
const consensusSessionResponseSchema = v.object({
  session: v.nullable(consensusSessionSchema),
})

export const getConsensusSessionContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: blockIdParams,
  pathResolver: ({ blockId }) => `/blocks/${blockId}/consensus-session`,
  responsesByStatusCode: { 200: consensusSessionResponseSchema, ...errorResponses },
})
