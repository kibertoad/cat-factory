---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/node-server': minor
'@cat-factory/worker': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Durable cost attribution: a spend rollup with no retention behind the TCO axes

The Reports view could already slice spend by repository and by tracker ticket, but it could not
answer either question durably, and nothing said so. Every attribution past the workspace was
assembled at READ time from three mutable sources: `token_usage`, pruned at ~13 months;
`agent_runs`, the row a call reaches the board through, prunable too; and the LIVE
`services.repo_github_id` / `tasks.linked_block_id` links, which an operator re-points whenever a
service moves repository or an issue is re-imported. So "what did this repository cost us last
quarter" gave one answer this month and a different, silently smaller one next year, and the ledger's
own durable rollup stopped at `(billing, vendor, provider, model)` for the current billing period.

The retention sweep now materialises `spend_days`: one row per `(workspace, UTC day, run, agent kind,
provider:model, billing, vendor)`, carrying the board shape FROZEN at rollup time: the run, its block
and title, its service and name, its repository id and `owner/name`, its task type, its ticket ref,
plus the account and board names. A read of it joins nothing, so nothing downstream can be re-pointed
or pruned out from under a report. `run` joins `repo` and `ticket` as a spend dimension on both
sources, so the finest TCO question ("what did that pipeline execution cost") is a grouped query too.

**It is never pruned, and that is the feature.** A TCO table has to outlive the ledger it was folded
from; one with a window is just a slower ledger. There is no `deleteOlderThan` on
`SpendRollupRepository` at all, so the absence is structural rather than an omission a future sweep
could quietly fill, and the table is excluded from the workspace-delete cascade for the reason
`audit_events` is: money already spent is an account-level fact that deleting a board does not undo.
Keeping it out of that list is only half of keeping it, though, because the sweep rewrites a trailing
window by deleting it and re-folding `token_usage`, which IS cascaded: for a deleted board the re-fold
reads nothing, so an unbounded window DELETE would have reclaimed its most recent days on the sweep's
own schedule with no further operator action. The rewrite is therefore scoped to workspaces that still
exist, which is the general rule that a rewrite may only delete what it can reproduce. What makes the
whole thing affordable is the grain. A run writes hundreds of ledger rows and a handful of these, so
the table grows with run volume, never call volume. The arithmetic is written down in
`backend/docs/storage-and-retention.md` §1c rather than left to be re-derived.

Reports routes by window: `24h`/`7d` still scan the ledger (millisecond-exact, and a sweep cadence
would show there as a missing tail), `30d`/`90d` read the rollup. Mixing sources inside one window was
rejected: every breakdown partitions the same rows and the totals fold from one of them, so a hybrid
would leave the tiles and the cards describing different data. The freshness cost is stated rather
than hidden: the projection carries `source` and `rolledUpThrough`, and the panel renders "no rollup
yet" / "the rollup is behind" / "complete through <date>", because an un-materialised rollup and an
account that spent nothing produce the same empty breakdown.

Worth a reviewer's attention: the fold has to REPRODUCE the ledger read's two fan-out guards (the
pre-aggregated service label over colliding frame block ids, and the deterministic lowest-ref pick for
a block linked from two tickets) rather than merely resemble them, or an account's spend would change
the moment a reader switched from `7d` to `30d`; the conformance suite asserts every dimension of the
rollup equals the ledger's answer on the same fixture, and then deletes the ledger, the runs and the
tickets and asserts the rollup is unchanged, and it does the same after deleting the boards themselves,
which is the only way to see that the account scope rides the row's own frozen `account_id` rather than
a `workspaces` join.

Unlike the daily run rollup, the pass resumes from its own watermark instead of a fixed lookback,
because a day missed here is missing from the only durable record of it. Each pass is span-capped, and
the first pass backfills 90 days so the longest window is not under-reported for a quarter while
looking complete. That backfill bound is deliberately NOT reused as the catch-up horizon: it answers
how much history a deployment adopts on its first pass, whereas a resumed pass has no such choice and
the ledger still holds every day since the watermark, so the horizon follows
`TOKEN_USAGE_RETENTION_DAYS` instead. Past the ledger's own retention there is nothing left to fold, and
the pass logs the span it gave up on, because a high-water mark structurally cannot represent a hole.
`rolledUpThrough` is the last COMPLETE day rather than the newest one written, since a sweep firing at
noon folds a day that keeps accruing after it returns; the panel measures its lag against the same day
boundary, so the verdict does not swing with the hour the report was opened. Ordering in the sweep is a
correctness property, not style: the rollup reads `token_usage`, so it runs before the prune that
bounds it, and it now shares that prune's window so the catch-up walk cannot step over days the next
statement is about to delete.
