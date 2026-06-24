---
'@cat-factory/app': patch
---

Refactor (no behaviour change): split the ~1,150-line `useApi.ts` client into
cohesive per-domain factory modules under `composables/api/*` (auth, fragments,
models, accounts, workspaces, board, execution, documents, tasks, reviews,
notifications, presets, releaseHealth, recurring, github, slack, bootstrap),
each taking a shared `ApiContext` (the authed `$fetch` instance + the path/header
helpers). `useApi()` builds the context once and spreads every group into the
same flat client, so all call sites stay `useApi().someMethod(...)` and every
endpoint's request/response shape is byte-identical.
