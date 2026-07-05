import { defineApiContract } from '@toad-contracts/valibot'
import { updateUserSettingsSchema, userSettingsSchema } from '../user-settings.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Per-USER settings route contracts. Scoped to the signed-in user (not a
// workspace), mounted at the root, so the paths here are absolute. See
// UserSettingsController in @cat-factory/server.
// ---------------------------------------------------------------------------

export const getUserSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/user-settings',
  responsesByStatusCode: { 200: userSettingsSchema, ...errorResponses },
})

export const updateUserSettingsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/user-settings',
  requestBodySchema: updateUserSettingsSchema,
  responsesByStatusCode: { 200: userSettingsSchema, ...errorResponses },
})
