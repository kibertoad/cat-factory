// The answers to every request the inspector panel sends when it opens on any block of the shared
// board (`board.stories.mocks.ts`), as a service whose GitHub repo is linked and where little else is
// configured yet.
//
// The panel loads the fragment catalog and the GitHub projection itself, and its sections load
// their own data: documents and tracker issues for a task, its requirements review, and for a
// service frame the environment handlers, release health, validation checks and test secrets.
// The list was taken from the requests the stories sent with no handler installed. A section
// added later shows up as an msw warning in the console until it is answered here.
import {
  getObservabilityConnectionContract,
  getRequirementReviewContract,
  getServiceTestSecretsContract,
  listDocumentsContract,
  listEnvironmentHandlersContract,
  listReleaseHealthConfigsContract,
  listServiceValidationConfigsContract,
  listTasksContract,
  resolvedFragmentsContract,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiHandler, apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import { fragmentCatalog } from './fragments.stories.mocks'
import { githubLoadApi } from './githubApi'

const pathPrefix = storyWorkspacePrefix
/** The per-block reads answer for whichever block is selected. */
const byBlock = { pathPrefix, pattern: { blockId: ':blockId' } }

export function inspectorApi(): HttpHandler[] {
  return [
    // The panel's own loads.
    apiResponse(resolvedFragmentsContract, { pathPrefix, body: fragmentCatalog }),
    ...githubLoadApi(),
    // A task's sections.
    apiResponse(listDocumentsContract, { pathPrefix, body: [] }),
    apiResponse(listTasksContract, { pathPrefix, body: [] }),
    apiHandler(getRequirementReviewContract, byBlock, () => null),
    // A service frame's sections.
    apiResponse(listEnvironmentHandlersContract, {
      pathPrefix,
      body: { handlers: [], customTypes: [] },
    }),
    apiResponse(getObservabilityConnectionContract, {
      pathPrefix,
      body: { connected: false, provider: null, summary: null },
    }),
    apiResponse(listReleaseHealthConfigsContract, { pathPrefix, body: [] }),
    apiResponse(listServiceValidationConfigsContract, { pathPrefix, body: [] }),
    apiHandler(getServiceTestSecretsContract, byBlock, ({ pathParams: { blockId } }) => {
      if (!blockId) throw new Error('The test secrets read has no block id')
      return { blockId, entries: [] }
    }),
  ]
}
