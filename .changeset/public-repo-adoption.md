---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
'@cat-factory/acceptance': patch
---

`/api/v1` can ADOPT a repository that already exists: `GET /api/v1/repos/available` lists what a
workspace's connection can reach, and `POST /api/v1/repos/link` adopts one by name. Surface version
1.44.0, additive.

The hole they close was invisible from the surface. `GET /api/v1/repos` serves the repositories a
workspace has LINKED, which is a set someone assembles in the app: linking is explicit per workspace,
the provider webhook for an added repository does not project one, and a resync refreshes what is
already linked rather than rediscovering the installation. So a repository that exists and is
perfectly reachable is absent from every public read until a human opens the picker, and
`POST /api/v1/services` answers 404 for its `repoId`, which is byte-for-byte what a caller gets for a
repository that does not exist. A deployment could CREATE a repository through this API (1.41.0's
bootstrap) and could not adopt one it already had.

The two reads are a population pair rather than a duplicate, with `linked` as the join, so an absent
repository is now diagnosable: reachable-but-unadopted appears in `/repos/available` with
`linked: false`, and one that does not exist appears in neither. The adopt takes `owner`/`name`
because a caller setting a workspace up from configuration knows the name and cannot know a provider
id for a repository no public read lists; it is idempotent, answers the same row shape `/repos`
serves (projected from the same read, so the two cannot disagree about whether a repository is free),
and refuses an unreachable one with `404 repo_not_reachable`, a reason that covers "does not exist"
and "your credential is not granted it" together because a provider answers those identically.
`GitHubSyncService.linkRepoBySlug` resolves through the same path the app's own picker uses, and
matches the OWNER as well as the name: a slug search can surface a look-alike, and linking that one
would file a caller's work in someone else's account while answering 200.

The acceptance suite uses them, which is what makes a hand-written `.env` a supported way in rather
than a setup only `configure` could finish. Spec 01 adopts a repository the workspace does not hold
instead of refusing; `target-repos` gates on REACHABILITY, point-reading `/repos/available` for
anything unlinked and reporting "reachable but not adopted yet" as a pass; and `configure` adopts each
repository rather than printing instructions for doing it by hand. Every attempt states its outcome,
because a loop that reports only its positive answer is indistinguishable from one doing nothing, and
what a refusal now asks for is only what no API can do: create the repository, and grant the
credential access to it.
