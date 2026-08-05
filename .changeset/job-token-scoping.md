---
'@cat-factory/kernel': minor
'@cat-factory/observability-otel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

Job tokens are scoped to the repos a run resolved, not the whole installation

A container dispatch's clone/push credential was a GitHub App token minted with no
`repository_ids`, so it reached every repository the workspace's installation covered. That made
the installation the blast radius of a fully compromised run, and the mitigation was advice
(scope the installation narrowly) rather than a mechanism. The narrowing mechanism already
existed and was proven on the mothership delegation path; this brings it to every dispatch.

`jobTokenRepoIds` collects the repos ONE job body names (the primary checkout plus fan-out
peers, the conflict-resolver's targeted peer, the merger's combined-diff siblings, and read-only
reference repos) and `buildDispatchTokenMint` turns them into `repository_ids`. That builder is
shared by both facades, which previously carried byte-identical copies of the "initiator PAT
first, else the deployment credential" decision: whose token and how wide are one question, so
they now have one implementation and cannot drift.

**Every path that hands a container a GitHub credential goes through it**, not just the step
executor: the repo bootstrapper, the env-config repairer, the frontend preview job and the
deploy clone target each name the one repo they touch. That totality is held by the TYPE, not by
review. Supplying the run context is what makes a mint a dispatch mint, and a context must carry
`repoIds`, so a new dispatcher cannot ship without deciding its scope. Engine calls (`RepoFiles`
reads, the gate and merge clients) pass no context and stay installation-wide by design: they act
as the deployment, and nothing they do reaches a container.

Three dispositions are deliberate. A leg on a DIFFERENT installation is dropped rather than
requested: one job carries one token, so such a repo is unreachable either way, and naming it
would only make GitHub reject the mint. A scope that cannot be expressed as repo ids widens to
installation-wide rather than dropping a leg the harness is about to clone, since minting for the
parseable remainder would trade a data problem for a run that fails deep in a `git clone`. And a
dispatcher whose own lookup came back empty passes an EMPTY scope rather than none, because
"could not resolve my repos" and "I am not a dispatch" are opposite facts that an absent field
renders identically. Neither widening is silent: a `warn` naming the run plus the new
`dispatch.token_scope_widened` counter, because a security property degrading quietly reads
exactly like one holding.

What this does NOT narrow, both by construction: the token still carries `Contents: write` for
the repos it covers (App tokens cannot be branch-scoped), and an initiator's personal PAT is
unaffected, since `repository_ids` is an App-token mechanism with no PAT equivalent.
`allowInitiatorPat` remains what bounds that.

The mothership delegation endpoint takes the same scope. A node may now name `repositoryIds`,
which is INTERSECTED with the installation's App-linked projection server-side: asking narrows
and can never widen, nothing left in scope is the existing uniform 404, and a malformed ask falls
back to the full linked set rather than a partial one.

Worth reviewing: what a scoped mint changed about CACHING. `GitHubAppAuth` keyed its in-memory
token cache by installation id alone, which made a scoped entry unsafe to store (it would
over-grant a later engine call, and be under-granted by one), so scoped mints bypassed the cache
entirely. On the delegation path that was already true and cheap; on the standard dispatch path
it would have put an RSA signature plus a GitHub round trip on every step and every re-dispatch
epoch, where a warm process previously paid one mint per installation per hour. Both sides now
key by installation + sorted scope through one `InstallationTokenCache`, so a narrowed token
caches beside the unscoped one and neither can serve or poison the other. That cache also evicts
lapsed entries, which keying by scope made necessary: a map bounded by the installation count
became one bounded by the number of distinct repo SETS a long-running node dispatches over.

The dispatch also reorders: the auxiliary-checkout resolution moved INTO the parallel I/O wave
and the token mint moved out behind it, because the mint's scope is what that resolution
produces. One round trip left the wave as another entered it, and the ordering is pinned by a
test, so a later latency pass cannot re-parallelise the mint back to installation-wide.
`backend/docs/security-model.md` Layer 3 is updated, and the "job tokens are installation-wide"
known gap is closed.
