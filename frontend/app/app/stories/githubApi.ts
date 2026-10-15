// The answers to the GitHub store's probe (`ensureProbed`), which many panels start when they
// open so their repository pickers light up: the board's connection, the providers it could
// connect instead, and the token check. The connection is the shared `acme` installation; a
// panel that should show the not-connected state passes `connected: false`, one on another kind
// of connection passes it as `connection`, and one about the token passes the check's verdict. A
// board that is not connected yet offers no way to connect unless the story passes the
// deployment's `connectOptions`.
import {
  getGitHubConnectionContract,
  getGitHubPatCheckContract,
  listGitHubIssuesContract,
  listGitHubPullsContract,
  listGitHubReposContract,
  listVcsConnectOptionsContract,
} from '@cat-factory/contracts'
import type {
  GitHubConnection,
  GitHubIssue,
  GitHubPatCheck,
  GitHubPullRequest,
  GitHubRepo,
  VcsConnectOption,
} from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiResponse, storyWorkspacePrefix } from './api'
import { authRepo, githubConnection } from './vcs.stories.mocks'

export function githubProbeApi({
  connected = true,
  connection = githubConnection,
  patCheck = { state: 'not_applicable' },
  connectOptions = [],
}: {
  connected?: boolean
  connection?: GitHubConnection
  patCheck?: GitHubPatCheck
  connectOptions?: VcsConnectOption[]
} = {}): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  return [
    apiResponse(getGitHubConnectionContract, {
      pathPrefix,
      body: { connection: connected ? connection : null },
    }),
    apiResponse(getGitHubPatCheckContract, { pathPrefix, body: patCheck }),
    apiResponse(listVcsConnectOptionsContract, { pathPrefix, body: { options: connectOptions } }),
  ]
}

/**
 * The probe, then what `github.load` reads for a connected board: the linked repositories, their
 * pull requests and their issues. A panel that calls `ensureLoaded` needs all of it. The probe
 * options pass through.
 */
export function githubLoadApi({
  repos = [authRepo],
  pulls = [],
  issues = [],
  ...probe
}: {
  repos?: GitHubRepo[]
  pulls?: GitHubPullRequest[]
  issues?: GitHubIssue[]
} & Parameters<typeof githubProbeApi>[0] = {}): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  return [
    ...githubProbeApi(probe),
    apiResponse(listGitHubReposContract, { pathPrefix, body: repos }),
    apiResponse(listGitHubPullsContract, { pathPrefix, body: pulls }),
    apiResponse(listGitHubIssuesContract, { pathPrefix, body: issues }),
  ]
}
