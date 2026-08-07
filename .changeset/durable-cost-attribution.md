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
What makes that affordable is the grain. A run writes hundreds of ledger rows and a handful of these,
so the table grows with run volume, never call volume. The arithmetic is written down in
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
tickets and asserts the rollup is unchanged. Unlike the daily run rollup, the pass resumes from its own
watermark instead of a fixed lookback, because a day missed here is missing from the only durable
record of it; each pass is span-capped, and the first pass backfills 90 days so the longest window is
not under-reported for a quarter while looking complete. Ordering in the sweep is a correctness
property, not style: the rollup reads `token_usage`, so it runs before the prune that bounds it.
