---
'@cat-factory/kernel': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/conformance': patch
---

Serve a mothership-mode node's run telemetry back down from the mothership when its own store holds
none. Telemetry is local-first, captured on the laptop and pruned there on a short window, with a
finished run's rows carried up by the ingest sweep — both halves of which are about the WRITE
direction. What that left was a node rendering two kinds of run blank: one whose local rows had been
pruned, and (the larger case the plan under-stated) one that was never local at all. A mothership-mode
SPA shows the whole org's board, so most runs a developer opens were driven by a hosted teammate or
another laptop, and every one of them showed an empty observability panel, a zero token rollup and no
web-search log — with nothing anywhere reporting a problem, because that is exactly what a run which
spent nothing looks like.

`POST /internal/telemetry/read` is the ingest's dual: a machine-authed, account-scoped endpoint
serving a CLOSED table of per-method-bounded, run-scoped reads. It is its own endpoint rather than
allow-listed persistence-RPC methods for ADR 0009's reason plus a sharper one — the persistence
registry resolves a repository WHOLE, so admitting a telemetry repo's reads there would route its
hot-path writes over the network, which is the entire thing the local-first bucket exists to prevent.
`listByExecution` is deliberately absent from the table on all three sinks (no cursor, so it is the
un-resumable bulk read the bucket forbids); the node drains the paged reads instead, which is what
the two new kernel port methods are for. An over-cap limit is refused, never clamped, and the
scope-bound workspace is stamped as the call's first argument rather than trusted from the caller.

On the laptop the rule is local-wins: the fallback is reached only on an empty local answer, so a run
this node is driving stops paying round trips the moment it records its first call, and capture is not
decorated at all. A failed fallback throws rather than degrading back into the empty answer it was
called to replace — the one hot-path caller already treats a metrics read as best-effort, so an
outage costs a board counter and never a run.

Compatibility break: `LlmCallMetricRepository` and `AgentContextSnapshotRepository` each gain a
required `listRunPage` method, so an out-of-tree implementation of either port must add it.
