// Moved to the runtime-neutral @cat-factory/server package (so the Node + local
// facades run the same GitHub client); re-exported here for existing Worker imports.
export {
  FetchGitHubClient,
  GitHubApiError,
  type FetchGitHubClientDependencies,
} from '@cat-factory/server'
