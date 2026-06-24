---
---

CI/docs/tooling: publish the executor-harness runner image **publicly** and
multi-arch (`linux/amd64` + `linux/arm64`) to **both GHCR and Docker Hub** so it
can be `docker pull`ed without building from source. Adds a manual publish script
(`backend/internal/executor-harness/scripts/publish-image.sh`, exposed as the
package's `image:publish`), extends `docker-publish.yml` to build multi-arch and
push to Docker Hub (gated on the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets,
GHCR-only without them), and updates the runner-pool guide, the harness README, the
root README, the local deploy README, and CLAUDE.md to point at the published image.
No library code or image content changed (the image tag is unaffected).
