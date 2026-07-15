---
'@cat-factory/local-server': minor
'@cat-factory/cli': patch
---

Resolve the local `container` deploy runner's image automatically — `LOCAL_DEPLOY_IMAGE` is now an
escape hatch, not a mandatory companion.

- **local-server:** `LOCAL_DEPLOY_RUNTIME=container` now works out of the box with no other
  variable. The deploy-harness image defaults to `RECOMMENDED_DEPLOY_IMAGE` — the version this
  backend release supports, kept in lockstep with the Worker's `wrangler.toml` pin and the
  deploy-harness `version` by the runner-image-tag sync (`scripts/sync-runner-image-tags.mjs`), so
  every facade resolves the SAME supported deploy image. This mirrors how `LOCAL_HARNESS_IMAGE`
  defaults to `RECOMMENDED_HARNESS_IMAGE`. `LOCAL_DEPLOY_IMAGE` is retained ONLY as an override to
  pin a custom/older build or a private-registry mirror (container mode no longer breaks boot when
  it is unset — only `native` still requires its `LOCAL_DEPLOY_HARNESS_ENTRY` companion).
- **cli:** `cat-factory init`/`env` now steer to the one-line `container` mode in the generated
  `.env` (and the scaffolded `.env.example`), documenting `LOCAL_DEPLOY_IMAGE` as an escape hatch
  with an auto-resolved default. `cat-factory k3s`, after provisioning a local cluster connection,
  now also points the user at enabling the deploy runner (`LOCAL_DEPLOY_RUNTIME=container`) so a
  guided Kubernetes-test-environment setup no longer stops one step short and fails mid-run with
  "no deploy runner wired".
