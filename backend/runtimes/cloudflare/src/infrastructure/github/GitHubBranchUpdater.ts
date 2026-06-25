// Lives in the runtime-neutral @cat-factory/server package (so every facade can wire the
// human-testing gate's "pull main" action); re-exported here for Worker imports.
export { GitHubBranchUpdater, type GitHubBranchUpdaterDependencies } from '@cat-factory/server'
