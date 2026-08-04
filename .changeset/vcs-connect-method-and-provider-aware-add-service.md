---
'@cat-factory/contracts': patch
'@cat-factory/integrations': patch
'@cat-factory/app': patch
---

Make the add-service and bootstrap surfaces provider-aware, so a workspace connected with a
personal access token is no longer offered GitHub-App affordances it cannot use.

`GitHubConnection` gains a required `method` (`app` | `pat`, reusing the `VcsConnectMethod`
vocabulary the connect-options route already speaks). It is derived in
`GitHubInstallationService` from the row's `appId`, which only the App connect path fills, since
that one mapper reads back rows written by the App connect, the per-workspace PAT connect and
local mode's auto-provisioner alike. The SPA gates the "grant the App access to this repo" link
on it through a single `appInstallationManageUrl` helper; both modals previously built a
`github.com/settings/installations/<id>` URL from any connection, which 404s for a GitLab PAT
connection and for local mode's synthetic PAT-backed one.

The connect fan-out (which methods a deployment can serve) becomes one `VcsConnectSurfaces`
component, replacing two copies and two hardcoded GitHub-App pickers: a GitLab-only deployment
previously had no way to connect from the add-service or bootstrap modal at all.

Add-service and bootstrap copy moves onto provider-parameterised `vcs.*` keys in all ten
locales; three add-service keys no component referenced are dropped with it. Copy that renders
before anything is connected reads a new `surfaceProvider` (the connected provider, else the only
one the deployment could connect, else neutral) rather than `provider`, whose "what is connected"
default named GitHub on a GitLab-only deployment.

A connection row predating the multi-App tier has no `appId`, so it reads as `pat` and loses the
grant-access link until the workspace reconnects.
