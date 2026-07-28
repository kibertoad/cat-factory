---
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/worker': patch
---

Drain the remaining silent promise drops in the backend and stop them regrowing. Every
`.catch(() => {})` in `backend/packages` and `backend/runtimes` now goes through
`runBestEffort`, so a swallowed failure leaves one `warn` naming the operation with its cause
attached, and `scripts/check-silent-catch.mjs` fails CI on a new one (a drop that genuinely needs
no report annotates itself with `// silent-catch-ok: <reason>`). The guard counts every spelling
of an empty handler, including a body holding only a comment — which caught two further drops:
the mothership event relay (`HttpMachineEventClient.publish`, which additionally now treats a
REFUSED publish as a failure rather than a delivery, so an expired machine token stops reading as
success) and the web-search query recorder.

`RepoOpContext` gains a required `logger`, which closes the spec-promotion hole: a tester run that
verified requirements but promoted none used to be indistinguishable from one that had nothing to
promote. `RunDispatcher`, `DeployerStepController` and `InitiativeLoopService` gain the logger they
previously had no way to report through — so an issue-writeback drop, a leaked provisioning lease
and a permanently-failing initiative tick are all visible now. `ExecutionWorkflow` binds its run
correlation once with `logger.child` and scrubs its poll-failure causes with `redactSecrets`.
