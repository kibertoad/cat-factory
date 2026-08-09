---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/kernel': patch
'@cat-factory/agents': patch
'@cat-factory/worker': patch
---

Mothership mode: widen the persistence RPC by thirteen methods across three surfaces that were
already REACHABLE from a mothership-mode node and broken, rather than merely absent.

Both owner-pair content libraries' repo-SYNC surfaces go remote (prompt fragments, foundational
services) on the premise the skills slice already retired: a node reaches GitHub through the
delegated App token, so those link / sync / unlink routes were live and failing. Introduces the
`librarySource` scope rule, `skillSource` generalised from an accountId to an `(ownerKind, ownerId)`
pair, and `ownerFieldUpsert`, which closes the id-keyed upsert gap the skills slice named: both
source tables conflict on `id` alone and never re-`SET` their owner columns, so binding only the
declared owner let an in-scope caller repoint another tenant's source at a repo it controls. That
rule reads an absent row as a create, so its lookup reports `found` / `absent` / `unreadable`
rather than a nullable owner: a source table a deployment cannot read must not be spent as the
admission a genuinely free id has earned.

`PromptFragmentRepository` gains `softDeleteBySource` on both runtimes, with a new
`defineFragmentLibrarySuite` parity assertion. Unlink retired a source's fragments with a
per-fragment `softDelete` loop, which going remote turns into one HTTPS round trip per fragment;
both sibling repo-sourced libraries already retired by source.

`reviewQuestionPostRepository` `claim`/`settle`/`get` join them. The engine writes that marker, so a
`claim` answering `unknown_method` was read by the caller's deliberate fallback as "someone else
holds the claim": every parked review on a local run skipped its ticket comment, and only a `warn`
said so.

Two Node routing gaps are fixed with them: the foundational-services catalog trio and the generated
fragment-brief store were built over the absent `db` and never re-pointed, so the allow-list named
them remote while only the Cloudflare facade could reach them. An un-routed repo is a `TypeError` on
the run path rather than a clean refusal, so a new guard asserts the relation structurally: every
repository a content-library helper builds and the allow-list names as remote must be re-pointed.

No public API or wire-shape change.
