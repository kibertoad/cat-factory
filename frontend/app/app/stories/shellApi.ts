// The answers to the integration probes the app shell starts: the sidebar on every board open, and
// the command bar each time it opens. Each probe decides whether a destination or a command shows,
// so a story that leaves one unanswered both warns and renders less than the app would. The board
// connects GitHub, Slack, Confluence, Figma and Jira, keeps no fragments of its own, and has both
// infrastructure providers set up. Pass `false` to turn an integration off: every read of it then
// answers 503, as a deployment that does not offer it does.
import {
  describeEnvironmentProviderContract,
  describeRunnerPoolProviderContract,
  getEnvironmentConnectionContract,
  getRunnerPoolConnectionContract,
  getSlackConnectionContract,
  listDocumentConnectionsContract,
  listDocumentSourcesContract,
  listTaskConnectionsContract,
  listTaskSourcesContract,
} from '@cat-factory/contracts'
import type { DocumentConnection } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiRefusal, apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import { fragmentLibraryApi } from './fragmentLibraryApi'
import { fragmentCatalog } from './fragments.stories.mocks'
import { githubProbeApi } from './githubApi'
import {
  documentConnections,
  documentSources,
  slackConnection,
  taskConnections,
  taskSources,
} from './integrations.stories.mocks'
import { providerProbeApi } from './setupApi'

const pathPrefix = storyWorkspacePrefix

/** The 503 a deployment answers for an integration it does not offer, in the controller's words. */
function notOffered(contract: Parameters<typeof apiRefusal>[0], message: string): HttpHandler {
  return apiRefusal(contract, {
    pathPrefix,
    status: 503,
    error: { code: 'unavailable', message },
  })
}

const documentsOff = 'Document-source integration is not configured'
const tasksOff = 'Task-source integration is not configured'
const environmentOff = 'Environment integration is not configured'
const runnersOff = 'Runner pool integration is not configured'

/**
 * The documents store's probe: the sources the deployment offers and the ones the board
 * connected. With `offered: false` both reads answer 503, as a deployment without the
 * integration does: every documents route goes through the same `requireCapability`.
 */
export function documentProbeApi({
  offered = true,
  connections = documentConnections,
}: { offered?: boolean; connections?: DocumentConnection[] } = {}): HttpHandler[] {
  if (!offered) {
    return [
      notOffered(listDocumentSourcesContract, documentsOff),
      notOffered(listDocumentConnectionsContract, documentsOff),
    ]
  }
  return [
    apiResponse(listDocumentSourcesContract, {
      pathPrefix,
      body: { sources: documentSources, oauthSources: [] },
    }),
    apiResponse(listDocumentConnectionsContract, { pathPrefix, body: { connections } }),
  ]
}

export function shellProbeApi({
  documents = true,
  tasks = true,
  slack = true,
  infrastructure = true,
}: {
  documents?: boolean
  tasks?: boolean
  slack?: boolean
  infrastructure?: boolean
} = {}): HttpHandler[] {
  return [
    ...githubProbeApi(),
    ...documentProbeApi({ offered: documents }),
    ...(tasks
      ? [
          apiResponse(listTaskSourcesContract, { pathPrefix, body: { sources: taskSources } }),
          apiResponse(listTaskConnectionsContract, {
            pathPrefix,
            body: { connections: taskConnections },
          }),
        ]
      : [
          notOffered(listTaskSourcesContract, tasksOff),
          notOffered(listTaskConnectionsContract, tasksOff),
        ]),
    slack
      ? apiResponse(getSlackConnectionContract, {
          pathPrefix,
          body: { connection: slackConnection, oauthEnabled: true },
        })
      : notOffered(getSlackConnectionContract, 'Slack integration is not configured'),
    ...fragmentLibraryApi('workspace', { resolved: fragmentCatalog }),
    ...(infrastructure
      ? providerProbeApi()
      : [
          notOffered(describeEnvironmentProviderContract, environmentOff),
          notOffered(getEnvironmentConnectionContract, environmentOff),
          notOffered(describeRunnerPoolProviderContract, runnersOff),
          notOffered(getRunnerPoolConnectionContract, runnersOff),
        ]),
  ]
}
