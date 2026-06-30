---
---

Fix production deploy: re-export `DeployContainer` from `deploy/backend`'s entrypoint so wrangler can resolve the Durable Object its `wrangler.toml` binds (`DEPLOY_CONTAINER`). The slice-10 PR added the binding and the library export but missed the deployment re-export, which broke `wrangler deploy`.
