// The answers to what the bootstrap modal reads when it opens: the workspace's reference
// architectures, the GitHub probe, and the connected installation's repositories, pull requests
// and issues (`github.load`), whose repositories fill the monorepo and template pickers.
import type { ReferenceArchitecture, VcsConnectOption } from '@cat-factory/contracts'
import { listReferenceArchitecturesContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiResponse } from './api'
import { storyWorkspacePrefix } from './workspace'
import { referenceArchitectures } from './bootstrap.stories.mocks'
import { githubLoadApi } from './githubApi'
import { authRepo, platformRepo } from './vcs.stories.mocks'

export function bootstrapApi({
  architectures = referenceArchitectures,
  connected = true,
  connectOptions,
}: {
  architectures?: ReferenceArchitecture[]
  connected?: boolean
  connectOptions?: VcsConnectOption[]
} = {}): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  return [
    apiResponse(listReferenceArchitecturesContract, { pathPrefix, body: architectures }),
    ...githubLoadApi({ repos: [authRepo, platformRepo], connected, connectOptions }),
  ]
}
