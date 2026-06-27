import { defineApiContract, withObjectKeys } from '@toad-contracts/valibot'
import * as v from 'valibot'
import { kaizenOverviewSchema, kaizenRunGradingsSchema } from '../kaizen.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Kaizen route contracts (read-only). Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See KaizenController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const executionIdParams = withObjectKeys(v.object({ executionId: v.string() }))

export const getKaizenOverviewContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/kaizen',
  responsesByStatusCode: { 200: kaizenOverviewSchema, ...errorResponses },
})

export const getKaizenRunGradingsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: executionIdParams,
  pathResolver: ({ executionId }) => `/executions/${executionId}/kaizen`,
  responsesByStatusCode: { 200: kaizenRunGradingsSchema, ...errorResponses },
})
