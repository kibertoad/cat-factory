---
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Local mode can link GitHub repos with the PAT, lighting up the "Add from existing
repo" board flow (previously the GitHub integration was App-only, so it returned 503
and the button stayed hidden — repos could only be linked via the `linkRepo` CLI).

With a `GITHUB_PAT` set, the local facade now serves the GitHub read/link endpoints
through the PAT-backed client:

- `config.github.enabled` is forced on in local mode when a PAT is present (the Node
  loader only enables it for a configured GitHub App).
- A workspace's installation is auto-provisioned from the PAT on first read
  (`AutoProvisioningInstallationRepository`), so `GET /github/connection` reports
  connected with no connect flow. The synthetic installation id matches the `linkRepo`
  CLI's, so CLI- and UI-linked repos share one installation.
- The repo picker lists repos via `/user/repos` (`PatGitHubClient.listInstallationRepos`),
  the PAT analogue of the App-only `/installation/repositories` (which 403s for a PAT).
- The connection reports `workflows: write` granted (the local PAT carries `workflow`
  scope), suppressing the advisory "missing workflows permission" banner.

`@cat-factory/node-server` gains a `githubInstallationRepository` option on
`buildNodeContainer` (default unchanged) so the local facade can wrap the repository,
and re-exports `DrizzleGitHubInstallationRepository`. This is a local-mode differentiator
(like the Docker runner and PAT token source); the Cloudflare/Node-proper facades keep
using the GitHub App.
