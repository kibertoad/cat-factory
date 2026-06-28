---
'@cat-factory/executor-harness': minor
---

Add a dedicated UI-tester image definition (`Dockerfile.ui`) for the `tester-ui` agent kind:
it layers Playwright + Chromium on top of the slim base executor image, so the browser is
isolated to the one kind that needs it and never bloats every other agent's cold-start. A
transport routes a job to this image when the dispatch option `image: 'ui'` is set. The base
image is unchanged. NOTE: the per-runtime routing into this image (a second Cloudflare
container class; image-per-step on the self-hosted-pool / local Docker transports) is the
remaining deploy-time step — the `image: 'ui'` dispatch seam is in place.
