import { defineApiContract } from '@toad-contracts/valibot'
import { localSettingsSchema, updateLocalSettingsSchema } from '../localSettings.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Local-mode operational settings route contracts (warm-container-pool sizing +
// per-repo checkout reuse). A per-deployment singleton mounted at the root;
// wired only on the local-mode facade (503 elsewhere). No secrets, so GET
// returns the plain config and PUT replaces it wholesale. See
// LocalSettingsController in @cat-factory/server.
// ---------------------------------------------------------------------------

export const getLocalSettingsContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/local-settings',
  responsesByStatusCode: { 200: localSettingsSchema, ...errorResponses },
})

export const updateLocalSettingsContract = defineApiContract({
  method: 'put',
  pathResolver: () => '/local-settings',
  requestBodySchema: updateLocalSettingsSchema,
  responsesByStatusCode: { 200: localSettingsSchema, ...errorResponses },
})
