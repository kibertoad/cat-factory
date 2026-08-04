---
'@cat-factory/contracts': minor
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

**Compatibility break (internal wire shape).** `method` is REQUIRED, not optional like the
`provider` discriminator beside it, so a response without it fails client-side contract
validation rather than being defaulted at each reader. That is deliberate: a client cannot decide
what to offer from a value it never received, and an optional field would leave the two
`toConnection` mappers free to forget it. A backend and an SPA from different releases are
therefore not interchangeable across this change.

The connect fan-out (which methods a deployment can serve) becomes one `VcsConnectSurfaces`
component, replacing two copies and two hardcoded GitHub-App pickers: a GitLab-only deployment
previously had no way to connect from the add-service or bootstrap modal at all.

Add-service and bootstrap copy moves onto provider-parameterised `vcs.*` keys in all ten
locales; three add-service keys no component referenced are dropped with it. Copy that renders
before anything is connected reads a new `surfaceProvider` (the connected provider, else the only
one the deployment could connect, else neutral) rather than `provider`, whose "what is connected"
default named GitHub on a GitLab-only deployment.

The bootstrap modal's manual "create the repository yourself" link is now WITHHELD on GitLab
rather than pointed at `gitlab.com`: a deployment may be bound to any self-hosted instance and
nothing on the wire names its web host yet, and a project created on the wrong instance looks
like success until the bootstrap push cannot find it. The intro copy keys off the same value, so
it no longer promises a one-click that isn't there.

A connection row predating the multi-App tier has no `appId`, so it reads as `pat` and loses the
grant-access link until the workspace reconnects.
