---
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

De-duplicate the GitHub reconcile pass across the two facades, and make every Node
periodic sweep non-overlapping through a single seam.

**Reconcile hoist (audit item 4).** `reconcileStaleRepos` and its two gone-installation
classifiers were duplicated verbatim between the Worker's `sync-consumer.ts` and the Node
`githubReconcile.ts` (the Node copy's own comment said "Mirrors the Worker's classification"),
with no shared test — so a change to one would silently diverge (one runtime stops tombstoning
dead installations while the other keeps working). The pass now lives once in
`@cat-factory/server` (`reconcileStaleRepos` + `GitHubReconcileDeps`), and each facade supplies
only its per-repo driver: the Worker enqueues on `GITHUB_SYNC_QUEUE` (or direct-syncs when
unbound), Node direct-syncs inline. The classifiers moved verbatim (their regex→structured-code
conversion is tracked separately as error-message-coverage I7). The 30-minute staleness window
is now the shared exported `GITHUB_RECONCILE_STALE_MS` (previously defined independently per
facade), and all reconcile logs — the per-repo lines AND the Worker's cron summary — now use a
single `sweep: 'github-reconcile'` field on both facades. The Worker's queue-less direct-sync
fallback also builds its DI container once per pass instead of once per stale repo.

**Non-overlapping Node sweepers (audit item 6).** The DB-heavy `initiativeLoop`, `recurring`,
and notification-escalation sweeps ran unguarded `setInterval` timers, so a pass that outlasted
its interval could be stacked — and two concurrent `runDue` passes could both observe "no active
run" and double-spawn. All eight Node sweeps (kaizen, github-reconcile, initiative loop,
recurring, notification escalation, environment TTL, and both retention sweeps) now go through
one `startSweeper` helper built on `toad-scheduler`: `preventOverrun` is the non-overlap guard,
`runImmediately` the run-once-first behaviour, and the `AsyncTask` error handler the best-effort
logging (each sweep names its task, so scheduler-surfaced errors identify their sweep), and
`unref` keeps the sweep timers from holding the process alive — the same contract as the
hand-rolled `setInterval(...).unref()` timers this replaced. A new sweeper physically cannot
forget the guard. Adds a `toad-scheduler` (^4.1.0) dependency to `@cat-factory/node-server`.
