---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/gitlab': minor
'@cat-factory/caching': minor
'@cat-factory/orchestration': minor
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

Review follow-ups on the pair, all still inside 1.44.0 and still additive:

Both rows now report whether a repository is SPOKEN FOR, from one account-scoped judgement.
`/repos/available` publishes `serviceId` and `linkedElsewhere` exactly as `/repos` does, because a
repository nobody here has linked can still back a service on another board of the account, and
`POST /api/v1/services` refuses it either way. A discovery read that could not say so handed a
caller a repository whose next call fails, and it was the acceptance gate that felt it first: it
green-lit a pass that then died on the adopt, after the run the gate exists to precede. The
judgement is now `PublicBoardReads.repoUse`, asked once of the projection (the repos list) and once
of a batch of ids (the available read), so there is no second derivation to drift.

The available read also publishes `truncated`. The provider legs behind it stop at a page cap and a
search cap, so on a wide connection the rows are a prefix and a reachable repository can be missing
from them, which is indistinguishable from the non-existence this read exists to diagnose. A
point-read (`?q=owner/name`) resolves the exact slug directly and stays authoritative either way.

A provider refusal is answered as one on BOTH operations and on either provider. The available read
was left unwrapped, so a revoked credential or a rate limit on it arrived as `500 internal` rather
than the documented 503/429; and the mapping recognised `GitHubApiError` alone, so a GitLab-connected
workspace got that same `500` for a revoked token on both routes. Kernel now owns a `VcsApiError`
base that both provider clients extend, which is the identity a consumer above the adapters branches
on.

The adopt is idempotent for a repository the credential can no longer reach: it resolves from what
the workspace LINKS before consulting the provider, so a re-run no longer answers 404 for a
repository `GET /api/v1/repos` still lists (a personal repository, or a narrowed App grant). And the
link's `owner` accepts a namespace PATH, so a GitLab project under nested groups can be adopted at
all: the available read published `group/subgroup` and the adopt refused it with a 422.

In the suite, "the connection cannot reach it" is now recognised by `details.reason`, not by the 404
alone: a deployment older than these endpoints answers an unmatched route with the same status, and
reading that as "create the repository" sent an operator to create one they already had.

Internal, breaking for in-repo callers only: `GitHubSyncService.listAvailableRepos` answers
`{ repos, truncated }` rather than an array, and the `viewerRepos` cache holds the whole page rather
than its items (an enumeration that stopped at the cap is a prefix, and caching only the rows served
that prefix to every later keystroke as the complete set).
