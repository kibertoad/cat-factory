---
'@cat-factory/contracts': patch
'@cat-factory/kernel': patch
'@cat-factory/orchestration': patch
'@cat-factory/integrations': patch
'@cat-factory/app': patch
---

Make the "environment provisioning failed" surface actionable when no deploy runner is wired.

- **Backend, provider-agnostic message:** the `EnvironmentProvisioningService` error for a
  render-needing config with no `deployJobClient` no longer hardcodes Kubernetes tooling (it
  reaches for any provider that needs a container-backed deploy). It names the runtime-neutral
  transport remedies (a self-hosted runner pool, `LOCAL_DEPLOY_RUNTIME`, or the Cloudflare
  `DeployContainer` binding) or using a config that provisions without a deploy container.
- **Structured failure reason:** `AgentFailure` gains an optional machine-readable `reason`
  (JSON column — no migration), and this condition carries `deploy_runner_unwired`
  (`EnvironmentFailureReason` in contracts) from the thrown `ValidationError` through the
  deployer-step failure path onto the run's failure, so the SPA can act on the cause without
  string-matching prose. Adds `getErrorReason` to the kernel error helpers.
- **Frontend, precisely-gated guidance:** the board's `AgentFailureCard` shows a "Set up
  environments" deep-link to Infrastructure → Test environments on `environment`-kind failures.
  The Kubernetes+local env-var hint (`LOCAL_DEPLOY_RUNTIME` + `LOCAL_DEPLOY_HARNESS_ENTRY` /
  `LOCAL_DEPLOY_IMAGE`) is now shown ONLY for the `deploy_runner_unwired` reason, in local mode,
  and for a `kubernetes` provision — so a docker-compose / transient / future non-K8s failure
  never shows inaccurate guidance.
