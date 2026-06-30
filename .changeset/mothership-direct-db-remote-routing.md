---
'@cat-factory/node-server': minor
---

Mothership mode (Phase 3 slice 3): route the board-load + run-path direct-db stores through the
remote registry when `db` is undefined. `buildNodeContainer` previously constructed these
org/durable stores directly from `options.db`, so a no-Postgres mothership-mode build would
`TypeError` on the first board load / run. They now go through a single exported
`pickRepoSource(remoteRepos, name, build)` seam: when `db` is undefined, `options.repos` is the
full-surface remote `Proxy` (from the local facade's `composeMothership`) and the repo is sourced
from there over RPC; otherwise the Drizzle repo is built over `db` exactly as before.

Routed: `githubInstallationRepository`, `repoProjectionRepository` and the five GitHub projections
(branch / PR / issue / commit / check-run), `runnerPoolConnectionRepository`, `bootstrapJobRepository`,
`referenceArchitectureRepository`, `envConfigRepairJobRepository`, `notificationRepository`,
`taskRepository` (issue writeback), and `subscriptionActivationRepository`. The separate
`DrizzleServiceFrameRepository` construction is removed — `buildResolveRepoTarget` now reuses
`repos.serviceRepository` (remote in mothership mode, Drizzle otherwise).

Routing is orthogonal to the server-side allow-list: an un-allow-listed remote method returns a
clean `unknown_method`, never a `db`-undefined `TypeError`. The standard (Postgres) build is
unchanged. Tests: `pickRepoSource` routing in `runtimes/node/test/mothership-repo-source.spec.ts`,
plus the existing no-Postgres build test which now exercises the remote-sourced repos and still makes
no build-time network call.

Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): the feature-flagged
integration repos owned by the sub-helpers (tasks / documents / environments / fragments / slack) and
the fake-mothership integration test (the runtime board-load + run-to-terminal assertion) remain
before the mothership boot can ship.
