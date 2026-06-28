---
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Drop persisted agent failures carrying a removed kind so a stale row can't brick the board.

`decision_timeout` was removed from the `AgentFailure` kind picklist when human decisions
stopped being timeout-limited. A run that failed before then still carries the obsolete kind
in its persisted failure JSON, which violates the now-closed picklist. Because the server
ships rows without validating them against the contract, one stale failure made the SPA's
response validation reject the entire workspace snapshot ("Can't reach the backend").

The three failure-column parsers (the shared execution mapper plus both runtimes' bootstrap
repositories) now drop a failure whose kind is no longer known, via the new shared
`isKnownAgentFailureKind` predicate. The run's `status` + `error` string still describe what
happened. This repair is temporary and marked for removal after the 2026-07-15 migration
grace cutoff.
