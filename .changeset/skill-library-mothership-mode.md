---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/app': patch
'@cat-factory/conformance': minor
---

Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
catalog reads and the repo-sync surface alike — so a local node with no main database can list,
sync and RUN a skill.

This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
alone while one with resources threw out of the resource fetch, so the feature read as wired. The
sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
positional binds them; it resolves the source's owning account server-side (memoised, sharing its
read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
reverse lookup across every account — stays mothership-internal.

`GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
`listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
credential through read EVERY tenant's installations and filtered in JS — unexposable over an
account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
two.

Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
reflects the skill repositories into its machine-API registry only when its own library is
configured, exactly as it does for fragments.
