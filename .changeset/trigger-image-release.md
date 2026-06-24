---
"@cat-factory/executor-harness": patch
---

Bump the executor-harness to republish the runner image and exercise the `docker-publish.yml` pipeline end to end (GHCR + Docker Hub). No harness behaviour change; the version bump touches the harness `package.json`, which is the path that gates the image publish.
