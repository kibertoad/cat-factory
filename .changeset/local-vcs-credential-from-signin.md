---
'@cat-factory/local-server': minor
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/contracts': minor
'@cat-factory/gitlab': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

Local mode takes its source-control token from the sign-in screen

A local deployment with no `GITHUB_PAT` / `GITLAB_PAT` used to send a developer to the right
token page and then have nowhere to put the result: the token had to go into `.env`, followed by
a restart. The sign-in screen now accepts it directly, and it becomes the deployment's own
credential (sealed on the machine under `ENCRYPTION_KEY`), live for the next dispatch, gate probe
and repo read. `.env` still wins where it is set, and closes the browser flow.

`@cat-factory/server` additionally exports `githubRepoOrigin`, the clone origin a dispatch already
fell back to, so a facade whose own resolver handles only the non-GitHub case can delegate the
GitHub half instead of restating the URL.

Internal breaks in the affected packages: `VcsIdentityEntry.configuredToken` and
`CoreDependencies.sharedStackCloneToken` are now getters, `buildGitLabEngineClient` takes a token
or a getter, and the local facade's `createLocalGitHubClient` / `createLocalGitLabClient` take a
token getter and always return a client (an unconfigured deployment REFUSES on use, naming the
fix, rather than presenting no client at all).
