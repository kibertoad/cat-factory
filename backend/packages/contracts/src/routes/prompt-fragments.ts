import { defineApiContract } from '@toad-contracts/valibot'
import { promptFragmentCatalogSchema } from '../entities.js'
import { errorResponses } from './_shared.js'

// ---------------------------------------------------------------------------
// Universal prompt-fragment catalog route contract. Workspace-independent and
// cacheable, served read-only at the root. See PromptFragmentController in
// @cat-factory/server.
// ---------------------------------------------------------------------------

export const listFragmentCatalogContract = defineApiContract({
  method: 'get',
  pathResolver: () => '/prompt-fragments',
  responsesByStatusCode: { 200: promptFragmentCatalogSchema, ...errorResponses },
})
