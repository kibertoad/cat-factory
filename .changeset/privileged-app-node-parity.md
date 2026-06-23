---
'@cat-factory/server': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': patch
---

Close a runtime-parity gap: the privileged GitHub App tier (ADR 0005 — repo
provisioning / create-repo) now works on the Node and local facades, not just the
Cloudflare Worker. Previously `loadNodeConfig` never parsed `github.privilegedApp`
and the Node container never built the privileged registry entry or wired
`repoProvisioningClient`, so a Node deployment with a privileged App configured
silently fell back to the manual repo-creation flow.

`FetchGitHubProvisioningClient` moves into the runtime-neutral `@cat-factory/server`
package (next to `FetchGitHubClient`, which already lived there); the Worker keeps a
thin re-export at its old path. The Node config loader now reads
`GITHUB_PRIVILEGED_APP_ID` + `GITHUB_PRIVILEGED_APP_PRIVATE_KEY`, and the Node
container builds the privileged App auth + the provisioning client under the same
condition the Worker does.

**Breaking:** a privileged App is wired on Node only when BOTH
`GITHUB_PRIVILEGED_APP_ID` and `GITHUB_PRIVILEGED_APP_PRIVATE_KEY` are set; a half-set
env leaves the tier unconfigured (parity with the Worker).
