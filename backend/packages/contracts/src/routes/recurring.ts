import { ContractNoBody, defineApiContract } from '@toad-contracts/valibot'
import * as v from 'valibot'
import {
  createScheduleSchema,
  pipelineScheduleSchema,
  scheduleRunSchema,
  updateScheduleSchema,
} from '../recurring.js'
import { errorResponses, singleStringParam } from './_shared.js'

// ---------------------------------------------------------------------------
// Recurring pipeline route contracts. Mounted under `/workspaces/:workspaceId`, so
// the paths here are relative to that prefix. See RecurringPipelineController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

const scheduleListSchema = v.array(pipelineScheduleSchema)
const scheduleRunListSchema = v.array(scheduleRunSchema)
const scheduleIdParams = singleStringParam('scheduleId')

export const listSchedulesContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/recurring-pipelines',
  responsesByStatusCode: { 200: scheduleListSchema, ...errorResponses },
})

export const createScheduleContract = defineApiContract({
  method: 'post',
  pathResolver: () => '/recurring-pipelines',
  requestBodySchema: createScheduleSchema,
  responsesByStatusCode: { 201: pipelineScheduleSchema, ...errorResponses },
})

export const updateScheduleContract = defineApiContract({
  method: 'patch',
  requestPathParamsSchema: scheduleIdParams,
  pathResolver: ({ scheduleId }) => `/recurring-pipelines/${scheduleId}`,
  requestBodySchema: updateScheduleSchema,
  responsesByStatusCode: { 200: pipelineScheduleSchema, ...errorResponses },
})

export const deleteScheduleContract = defineApiContract({
  method: 'delete',
  requestPathParamsSchema: scheduleIdParams,
  pathResolver: ({ scheduleId }) => `/recurring-pipelines/${scheduleId}`,
  responsesByStatusCode: { 204: ContractNoBody, ...errorResponses },
})

export const listScheduleRunsContract = defineApiContract({
  method: 'get',
  requestPathParamsSchema: scheduleIdParams,
  pathResolver: ({ scheduleId }) => `/recurring-pipelines/${scheduleId}/runs`,
  responsesByStatusCode: { 200: scheduleRunListSchema, ...errorResponses },
})

export const runScheduleNowContract = defineApiContract({
  method: 'post',
  requestPathParamsSchema: scheduleIdParams,
  pathResolver: ({ scheduleId }) => `/recurring-pipelines/${scheduleId}/run-now`,
  requestBodySchema: ContractNoBody,
  responsesByStatusCode: { 200: pipelineScheduleSchema, ...errorResponses },
})
