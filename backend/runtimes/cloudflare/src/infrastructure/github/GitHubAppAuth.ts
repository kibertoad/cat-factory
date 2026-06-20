// Moved to the runtime-neutral @cat-factory/server package (Web Crypto runs under
// Node too, so the Node service mints installation tokens the same way);
// re-exported here for existing Worker imports.
export { GitHubAppAuth, type GitHubAppAuthDependencies } from '@cat-factory/server'
