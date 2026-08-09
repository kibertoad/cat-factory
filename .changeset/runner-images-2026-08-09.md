---
'@cat-factory/executor-harness': minor
'@cat-factory/deploy-harness': patch
---

Rebuild both per-run container images: the shared `node:26-trixie-slim` base moves to the current
index digest, and the executor image's three bundled agent CLIs move to Pi 0.84.1, Claude Code
2.1.226 and Codex 0.147.0. The Pi todo/web-tools extensions are already on their newest release
(2.4.0), so they stay put.

Both image tags are bumped in this change (`cat-factory-executor:1.105.0`,
`cat-factory-deploy:0.2.12`): republishing over a live tag does not roll a deployment out.
