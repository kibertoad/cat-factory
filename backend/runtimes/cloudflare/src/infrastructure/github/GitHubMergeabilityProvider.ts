// Moved to the runtime-neutral @cat-factory/server package (so every facade can wire
// the conflicts gate); re-exported here for existing Worker imports.
export {
  GitHubMergeabilityProvider,
  classifyMergeability,
  type GitHubMergeabilityProviderDependencies,
} from '@cat-factory/server'
