import { defineApiContract } from '@toad-contracts/valibot'
import { blockSchema } from '../entities.js'
import { executionInstanceSchema } from '../execution.js'
import {
  adoptBugHuntCandidateSchema,
  bugHuntResultSchema,
  runBugHuntSchema,
  trackerBoardsViewSchema,
} from '../bug-hunt.js'
import { sourceTaskSchema } from '../tasks.js'
import * as v from 'valibot'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Bug-hunt route contracts. Mounted under `/workspaces/:workspaceId`, so the paths
// here are relative to that prefix. See BugHuntController.
//
// Three steps, one per user action: list a source's boards, run the hunt against one,
// adopt the confirmed candidate. The first two are reads with no side effects (the hunt
// POSTs because it carries predicates and performs a live external call, like the
// diagnostics probe); only the adopt writes.
// ---------------------------------------------------------------------------

const sourceParams = singleStringParam('source')

const adoptBugHuntResultSchema = v.object({
  block: blockSchema,
  task: sourceTaskSchema,
  execution: executionInstanceSchema,
})
export type AdoptBugHuntResult = v.InferOutput<typeof adoptBugHuntResultSchema>

export const listTrackerBoardsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/bug-hunt/${source}/boards`,
  responsesByStatusCode: { 200: trackerBoardsViewSchema, ...errorResponses },
})

export const runBugHuntContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/bug-hunt/${source}/hunts`,
  requestBodySchema: runBugHuntSchema,
  responsesByStatusCode: { 200: bugHuntResultSchema, ...errorResponses },
})

export const adoptBugHuntCandidateContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: sourceParams,
  pathResolver: ({ source }) => `/bug-hunt/${source}/adoptions`,
  requestBodySchema: adoptBugHuntCandidateSchema,
  responsesByStatusCode: { 201: adoptBugHuntResultSchema, ...errorResponses },
})
