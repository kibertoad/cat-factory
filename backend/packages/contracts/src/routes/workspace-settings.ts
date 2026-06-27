import { defineApiContract } from '@toad-contracts/valibot'
import { updateWorkspaceSettingsSchema, workspaceSettingsSchema } from '../workspace-settings.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-workspace runtime-settings route contracts. Mounted under
// `/workspaces/:workspaceId`, so the paths here are relative to that prefix.
// See WorkspaceSettingsController.
// ---------------------------------------------------------------------------

export const getWorkspaceSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/settings',
  responsesByStatusCode: { 200: workspaceSettingsSchema, ...errorResponses },
})

export const updateWorkspaceSettingsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/settings',
  requestBodySchema: updateWorkspaceSettingsSchema,
  responsesByStatusCode: { 200: workspaceSettingsSchema, ...errorResponses },
})
