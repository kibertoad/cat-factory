---
'@cat-factory/kernel': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
---

Fold a board's un-rolled spend inside its own delete, so the durable record ends where the board did

`spend_days` is deliberately outside the workspace-delete cascade: money already spent is an
account-level fact, and reclaiming it would shrink last quarter's TCO retroactively and silently.
Keeping it out of that list was made real by bounding the sweep's rewrite to boards that still
exist, because `token_usage` IS cascaded and an unbounded window DELETE would otherwise re-fold
nothing and reclaim the deleted board's most recent days on the sweep's own schedule.

That bound left the mirror-image gap, which this closes. The sweep reaches only boards that still
exist, so a board's spend SINCE the last completed rollup day has never been folded when its delete
begins, and its ledger rows go with the cascade before any later pass could see them. The loss was
bounded by the sweep interval, permanent, and skewed worst for exactly the boards an operator
deleted because they were expensive. `WorkspaceService.delete` now runs one final per-workspace fold
before the cascade, beside the binary-artifact purge and for the same reason: afterwards there is
nothing left to read.

Three things make that fold a different shape from a sweep pass, and each was a decision rather than
a detail:

- **It walks to now in chunks instead of capping its window.** A sweep can leave a wide catch-up for
  its next pass; this board has no next pass, so the span cap becomes a chunk size rather than a
  truncation. Truncating would have introduced a second, quieter version of the same loss.
- **It does not touch the coverage marker.** `rolledUpThrough` is deployment-scoped and states how
  far the SWEEP has covered every board at once. One board's final fold covers no other board's
  days, and the marker only ever moves forward, so advancing it there would permanently present
  days nothing folded as covered.
- **It keeps the still-exists guard anyway.** Called after the cascade the fold reads nothing, and
  an unguarded window DELETE would then reclaim the frozen rows the exclusion exists to keep. The
  guard makes the fold-then-cascade ordering a property of the query rather than of the call site,
  so both halves of "a rewrite may only delete what it can reproduce" live in the same statement.

The resume point and the ledger-retention horizon are the sweep's own, which is why the pure walk
(`spendRollupWindow` plus the new `finalSpendFoldPlan`) moved from `@cat-factory/orchestration` into
kernel: the two callers sit in different layers and restating the horizon rule per caller is exactly
how the delete path would end up stepping over days a sweep would still have folded. Facades now
wire `tokenUsageRetentionMs` onto `CoreDependencies` so both derive it from one number.

The fold is best-effort, which is a trade worth reviewing: refusing the delete on a sick rollup query
would keep the spend foldable for a retry, but it would also render a reporting outage as a board
that cannot be deleted. So the delete proceeds and the failure is named at `warn`, as is the span
past the ledger's own retention, which was already unfoldable before the delete began.
