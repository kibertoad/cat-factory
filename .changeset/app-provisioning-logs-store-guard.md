---
'@cat-factory/app': patch
---

fix(app): guard the provisioningLogs store against out-of-order clobber + unbounded growth (audit item 10)

The `provisioningLogs` store's `loadForExecution` did an unguarded `s.entries = entries`, so the
drawer's silent background poll and a manual refresh could resolve out of order and let a
slower/staler fetch overwrite the fresher timeline (the same out-of-order-overwrite hazard the
live-push rules warn about). And `byExecution` accreted one `LogState` per execution viewed and
never evicted — a slow memory creep across a long board session. Adds a per-execution monotonic
`loadSeq` guard (only the latest-issued load commits its result, matching `stores/workspace.ts`)
and an `evict(executionId)` the `ProvisioningLogsDrawer` calls on unmount, so the map holds only
currently-open drawers (a re-opened drawer re-fetches on mount). Behaviour-neutral for the happy
path; pins the races with new store specs.
