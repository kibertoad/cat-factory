---
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/server': patch
---

Internal refactor of mothership-mode code (no behaviour change): share one `node:sqlite` open
helper between the local credential store and work queue, make `statusForPersistenceError` a
lookup table, inline the trivial mothership db-path wrappers, bind `pickRepoSource` through a
local `sourced` helper (collapsing the repeated `remoteRepos`/`db` wiring, including the five
GitHub projection repos) in the Node container, and centralize the mothership-vs-Postgres
persistence decision in the local container behind a single `resolveLocalPersistence` helper.
