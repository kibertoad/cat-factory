---
'@cat-factory/integrations': patch
---

Fix a 500 when flagging a repo as a monorepo while adding it as an existing
service. The add-service flow flips the monorepo toggle (and browses the tree)
before the repo is linked to the workspace, but `setRepoMonorepo` /
`listRepoDirectory` threw `Repo … is not linked` for an untracked repo. Both now
lazily link the repo via `linkRepo` first, throwing only when the repo isn't
accessible to the installation.
