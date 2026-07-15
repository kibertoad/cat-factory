---
'@cat-factory/orchestration': patch
'@cat-factory/worker': patch
---

Poll-first durable drivers: the execution drivers (orchestration `driveExecution` and the Cloudflare `ExecutionWorkflow`) now poll a just-dispatched container job immediately instead of sleeping a full poll interval (default 15s) first, so the first running/subtask state reaches the board with no leading dead air. Gate prechecks deliberately keep the sleep-first shape (the precheck just ran inside advance/pollGate). The Cloudflare Bootstrap/EnvironmentTest/EnvConfigRepair workflows are flipped the same way, matching their already-poll-first Node runner twins.
