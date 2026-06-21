// Moved to the runtime-neutral @cat-factory/server package (so every facade can merge
// for real); re-exported here for existing Worker imports.
export {
  GitHubPullRequestMerger,
  type GitHubPullRequestMergerDependencies,
} from '@cat-factory/server'
