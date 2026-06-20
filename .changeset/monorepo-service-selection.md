---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/executor-harness': minor
'@cat-factory/app': minor
---

Monorepo support: select a subset of a repo's services and pin each to a subdirectory.

A linked GitHub repository can now be flagged a **monorepo** (`github_repos.is_monorepo`,
D1 migration `0034` ⇄ Drizzle), which lets it back **more than one** board service —
each pinned to its own subdirectory (`services.directory`). The "Add service from repo"
modal gains a monorepo toggle and a **directory browser** (`GET
/workspaces/:ws/github/repos/:id/tree`, served from GitHub's contents API via
`GitHubSyncService.listRepoDirectory`) so you can explore the repo and pick the
directory of the service you want — and add several (a subset of the repo's services).
`PATCH /workspaces/:ws/github/repos/:id` sets the monorepo flag.

The chosen subdirectory is **fed to every agent that works on the service** when the
repo is a monorepo: `buildResolveRepoTarget` resolves a frame's service (so multiple
frames can target one repo) and returns its `serviceDirectory`, which flows through the
container job body into the harness — the coding agents (coder/mocker/tester/ci-fixer/
conflict-resolver) run with their working directory set to that subtree and are told, in
their AGENTS.md context, that they're in a monorepo and to scope their work (and build/
test commands) to it. Non-monorepo repos keep the historical whole-repo behaviour.
