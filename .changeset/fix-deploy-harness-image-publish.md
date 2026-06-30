---
---

CI: publish the deploy-harness (k8s render) image to the Cloudflare managed registry
in the production deploy workflow, mirroring the executor image. Fixes the
`IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE` failure on `wrangler deploy` when creating the
`DeployContainer` application, and bumps the `cat-factory-deploy` tag pins
(`deploy/backend/package.json` + `wrangler.toml`) into lockstep with the harness
version (0.2.3). The runner-image tag guard now covers both container images.
