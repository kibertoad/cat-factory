---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/gitlab': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': patch
'@cat-factory/conformance': patch
---

Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
deployment can now connect a workspace to GitLab by pasting a personal access token: the
token is validated against the account's identity, sealed at rest (a new `access_token`
column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
`ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
(503 until GitLab connect is wired). The connect UI is a follow-up slice.
