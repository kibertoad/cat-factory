import { defineApiContract } from '@toad-contracts/valibot'
import { putTrackerSettingsSchema, trackerSettingsSchema } from '../tracker.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Issue-tracker settings route contracts. Mounted under `/workspaces/:workspaceId`,
// so the paths here are relative to that prefix. See TrackerSettingsController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

export const getTrackerSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/tracker-settings',
  responsesByStatusCode: { 200: trackerSettingsSchema, ...errorResponses },
})

export const putTrackerSettingsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/tracker-settings',
  requestBodySchema: putTrackerSettingsSchema,
  responsesByStatusCode: { 200: trackerSettingsSchema, ...errorResponses },
})
