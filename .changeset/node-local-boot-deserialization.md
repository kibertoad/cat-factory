---
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
---

Node/local boot de-serialization (app-startup initiative, items 2/5/6). The Node facade brings up its five pg-boss consumers (execution / bootstrap / env-config-repair / env-test / github-sync) as one `Promise.all` wave instead of awaiting them serially — each is an independent queue with no ordering dependency, so this collapses ~10 back-to-back DB round trips on the boot path to ~2 (kept after `boss.start()` and before listen, invariant unchanged). The best-effort Redis reachability probe (`warnIfRedisUnreachable`) and local mode's GitHub PAT probe are now fire-and-forget (`warnIfRedisUnreachableInBackground` / `warnOnGitHubPatProblemInBackground`) rather than awaited, so a set-but-down Redis bus no longer stalls boot for ~3.5s and a slow github.com round-trip no longer precedes `start()`. Both probes still log their single warning if/when they resolve; the local runtime `--version` preflight stays awaited (it gates limited mode).
