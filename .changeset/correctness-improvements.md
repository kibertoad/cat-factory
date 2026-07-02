---
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/contracts': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
'@cat-factory/conformance': patch
---

Correctness fixes across the engine, the Node facade, and the SPA stores:

- **Engine:** `finalizeMerge` and the merger resolver are now idempotent under
  durable-driver replays — a re-resolved merger step on an already-`done` (= merged)
  block is a no-op instead of re-merging, downgrading the block to `pr_ready`, and
  raising a spurious `merge_review` notification. `approveStep` now runs under the same
  optimistic-concurrency write as its siblings (`resolveDecision`/`requestStepChanges`),
  so an approve holding a stale snapshot can no longer resurrect a run a racing reject
  already failed (it now returns 409).
- **CI gate (behavior change):** a check run concluding `stale` (superseded by GitHub)
  no longer fails the CI gate — previously it looped the `ci-fixer` against a check it
  could never fix until the attempt budget failed the run. `cancelled`/`timed_out`/
  `action_required` still fail the gate.
- **Node facade parity:** the retention sweep now prunes the `github_commits`
  projection to `retention.commitMs` (previously it grew without bound; the Worker
  already pruned it), and a new every-2-min GitHub reconcile sweeper re-syncs stale
  repo projections and tombstones uninstalled installations — the backstop for missed
  webhooks the Worker's `github-reconcile` cron already provided.
- **SPA stores:** the execution store now reconciles snapshots/events monotonically by
  the run's `rev` (a lagging refresh can no longer revert a just-terminal run to
  `running`), the requirements/clarity/brainstorm stores guard live-event upserts by
  `updatedAt` (out-of-order events no longer revert just-submitted answers), and
  `board.moveBlock`/`updateBlock` roll their optimistic mutation back on API failure.
