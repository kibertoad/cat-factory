---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

GitLab UI parity (pre-slice): carry a `provider` VCS discriminator on the repo/connection
projection.

The GitLab-parity SPA work (provider-aware labels, icons, host/URL shapes) needs a
`provider: VcsProvider` (`'github' | 'gitlab'`) it can read off the data. This adds that
field to the `GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` wire types and the
kernel `GitHubInstallation`, and persists it symmetrically on both runtimes' projection
tables (D1 migration `0051_vcs_provider.sql` + a Drizzle migration + both sets of mappers).
The tables keep their GitHub names — the entity-rename fold is separate, acknowledged Phase-1
work.

`provider` is a per-connection fact: a connection records it (`GitHubInstallationService.connect`
→ `'github'`; local mode's `AutoProvisioningInstallationRepository` → the deployment's provider,
`'gitlab'` for a GitLab-PAT deployment), and the repos reached through it inherit it (the sync
service stamps `installation.provider`, the bootstrapper and CLI `linkRepo` stamp their own).
Rows written before the column default to `'github'`. A cross-runtime conformance suite
(`defineVcsProviderSuite`) asserts the round-trip on both stores. No SPA behaviour changes yet;
this unblocks the presentation-switch slices.
