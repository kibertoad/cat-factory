// The answers to a repository's file reads: one folder at a time (the folder browser), and every
// file at once (the path search). Both read the same list, by default `acme/platform`'s.
import type { RepoTreeEntry } from '@cat-factory/contracts'
import { listGitHubRepoFilesContract, listGitHubRepoTreeContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { apiHandler } from './api'
import { storyWorkspacePrefix } from './workspace'
import { folderOf, platformFiles } from './repoFiles.stories.mocks'

export function repoFilesApi(files: RepoTreeEntry[] = platformFiles): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  const pattern = { repoGithubId: ':repoGithubId' }
  return [
    apiHandler(listGitHubRepoTreeContract, { pathPrefix, pattern }, ({ query }) =>
      folderOf(files, query.get('path') ?? ''),
    ),
    apiHandler(listGitHubRepoFilesContract, { pathPrefix, pattern }, () => files),
  ]
}
