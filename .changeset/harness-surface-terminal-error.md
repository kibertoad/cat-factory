---
'@cat-factory/executor-harness': patch
---

Fail a container agent run when Pi ends in a terminal error, even on exit 0.

Pi can exit 0 while the agent run itself ended in a hard error (every model call
failed and its auto-retries were exhausted). The harness judged success purely on
exit code plus whether the work branch carried commits, so a run that RESUMED a
branch with prior checkpoint commits would open a PR off work this pass never
produced, and a totally-failed implementation surfaced as a green pipeline.

`runPi` now inspects Pi's terminal transcript (`terminalRunError`: the trailing
`auto_retry_end success:false`, or the last `agent_end` with `stopReason: error`)
and rejects with that message on exit 0, so the job is reported failed across every
container agent kind (coder/ci-fixer/bootstrap/blueprint/merger). A mid-run error
the agent recovered from leaves a clean terminal event and is unaffected.

Bumps the executor image tag (1.0.3 -> 1.0.4).
