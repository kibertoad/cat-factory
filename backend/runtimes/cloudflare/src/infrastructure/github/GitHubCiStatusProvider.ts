// Moved to the runtime-neutral @cat-factory/server package (so every facade can wire
// the CI gate); re-exported here for existing Worker imports.
export {
  GitHubCiStatusProvider,
  type GitHubCiStatusProviderDependencies,
} from '@cat-factory/server'
