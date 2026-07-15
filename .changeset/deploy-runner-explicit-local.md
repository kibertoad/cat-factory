---
'@cat-factory/local-server': minor
'@cat-factory/integrations': patch
'@cat-factory/cli': patch
---

Make the local Kubernetes deploy runner explicit and its misconfiguration loud.

- **local-server (BREAKING for `LOCAL_DEPLOY_RUNTIME`):** `LOCAL_DEPLOY_RUNTIME` no longer
  defaults to `native`. It is unset ⇒ deploy stays unwired (the normal "no Kubernetes test
  environments" state); set explicitly to `native` or `container` to wire it. A mode set WITHOUT
  its mandatory companion variable (`LOCAL_DEPLOY_HARNESS_ENTRY` for `native`,
  `LOCAL_DEPLOY_IMAGE` for `container`) — or an unrecognised value — now BREAKS boot with an
  actionable config error instead of warning and silently degrading to an unwired deploy that
  only failed mid-run. `native` was the more brittle, higher-privilege mode, so it must be chosen
  deliberately rather than fallen into.
- **integrations:** the `deploy_runner_unwired` provisioning failure message now spells out each
  facade's exact setting and, for local mode, both modes' companion variables and how they differ.
- **cli:** `cat-factory init` and `cat-factory env` now document the three `LOCAL_DEPLOY_*`
  variables in the generated `.env` (and the scaffolded `.env.example`), commented out — deploy is
  unused by default, and no companion var is written active since a lone mode breaks boot.
