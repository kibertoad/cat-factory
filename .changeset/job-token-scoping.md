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
existed and was proven on the mothership delegation path; this brings it to the standard
dispatch path.

`jobTokenRepoIds` collects the repos ONE job body names — the primary checkout plus fan-out
peers, the conflict-resolver's targeted peer, the merger's combined-diff siblings, and read-only
reference repos — and `buildDispatchTokenMint` turns them into `repository_ids`. That builder is
shared by both facades, which previously carried byte-identical copies of the "initiator PAT
first, else the deployment credential" decision: whose token and how wide are one question, so
they now have one implementation and cannot drift.

Two dispositions are deliberate. A leg on a DIFFERENT installation is dropped rather than
requested: one job carries one token, so such a repo is unreachable either way, and naming it
would only make GitHub reject the mint. And a scope that cannot be expressed as repo ids widens
to installation-wide rather than dropping a leg the harness is about to clone — minting for the
parseable remainder would trade a data problem for a run that fails deep in a `git clone`. The
widening is never silent: a `warn` naming the run plus a new `dispatch.token_scope_widened`
counter, because a security property degrading quietly reads exactly like one holding.

What this does NOT narrow, both by construction: the token still carries `Contents: write` for
the repos it covers (App tokens cannot be branch-scoped), and an initiator's personal PAT is
unaffected, since `repository_ids` is an App-token mechanism with no PAT equivalent.
`allowInitiatorPat` remains what bounds that.

The mothership delegation endpoint takes the same scope. A node may now name `repositoryIds`,
which is INTERSECTED with the installation's App-linked projection server-side: asking narrows
and can never widen, nothing left in scope is the existing uniform 404, and a malformed ask falls
back to the full linked set rather than a partial one. `DelegatedAppTokenSource` keys its memo by
installation + sorted scope, because an installation-keyed entry would serve one run another
run's scope.

Worth reviewing: the dispatch reorders. The auxiliary-checkout resolution moved INTO the parallel
I/O wave and the token mint moved out behind it, because the mint's scope is what that resolution
produces. Latency is a wash (one round trip left the wave as another entered it) and the ordering
is pinned by a test, so a later latency pass cannot re-parallelise the mint back to
installation-wide. `backend/docs/security-model.md` Layer 3 is updated, and the "job tokens are
installation-wide" known gap is closed.
