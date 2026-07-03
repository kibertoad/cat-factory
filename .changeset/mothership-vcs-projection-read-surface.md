---
'@cat-factory/server': patch
---

mothership: allow-list the VCS / GitHub projection read surface

In mothership mode the SPA's VCS board panels (repos / branches / pull requests / issues) were not
functional over `/internal/persistence`: the projection reads `GitHubService` (`container.github`)
serves straight from the local projections came back `unknown_method`. This widens
`REMOTE_PERSISTENCE_METHODS` with those reads, each workspace-scoped on arg0 (the existing
`workspace` rule — no new scope machinery), read-only and member-level (the GitHub read endpoints
mount under `/workspaces/:workspaceId`, not admin-gated):

- `repoProjectionRepository.list` — the repos panel.
- `branchProjectionRepository.listByRepo` — a repo's branches.
- `pullRequestProjectionRepository.listByWorkspace` — the pull-requests panel.
- `issueProjectionRepository.listByWorkspace` — the issues panel.
- `githubInstallationRepository.getByWorkspace` — the run path's installation lookup (see below).

`repoProjectionRepository.list` is ALSO on the run path — `resolveRepoTarget` walks the
`github_repos` projection to find a block's repo on EVERY container-agent dispatch. But it reads
`githubInstallationRepository.getByWorkspace` FIRST (returning null when GitHub isn't connected),
so closing the run-path gap for real (non-fake-executor) runs needs BOTH reads: with only `list`
allow-listed the resolver still failed one call earlier on the un-remoted installation read. Its
other deps — `blockRepository.get`, `serviceRepository.getByFrameBlock` — are already remote, so
adding `getByWorkspace` + `list` genuinely closes it (the merge-gate integration test uses the
`FakeAgentExecutor`, which bypasses repo resolution, so the gap didn't surface there).

Still off the SPA path (a later GitHub sync + repo-write slice): the projection WRITE surface —
`upsertMany` (the sync/webhook ingest; the mothership owns GitHub sync, since the App + webhooks
live there), the board-linkage writes `repoProjectionRepository.linkBlock` / `setMonorepo`, the
installationId-keyed sync cursors, `tombstoneMissing`, and the per-repo `listByRepo` variants the
panels don't drive. `repoProjectionRepository.get` stays off too: it backs only
`GitHubService.resolve` for the repo-WRITE endpoints (create-branch / open-PR / merge / comment),
and exposing it alone would let create-branch/open-PR do the real GitHub write and THEN fail on the
un-remoted `upsertMany` projection refresh — a worse failure than today's clean pre-write refusal.

Still off on the installation repo: only the workspace-scoped `getByWorkspace` the run path needs
is opened; its installationId-keyed reads, the token/sync writes, the webhook fan-out, and the
cron `listActive` stay off (the same later GitHub sync + repo-write slice).

The projection repos + the installation repo are already routed through the `pickRepoSource`/
`sourced` seam, so a mothership-mode node already sources them from the full-surface remote registry
when `db` is undefined — an allow-list change only, symmetric by construction (the dispatcher
reflects over each facade's registry).
