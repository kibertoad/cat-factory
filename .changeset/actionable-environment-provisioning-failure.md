---
'@cat-factory/integrations': patch
'@cat-factory/app': patch
---

Make the "environment provisioning failed" surface actionable when no deploy runner is wired.

The `EnvironmentProvisioningService` error for a render-needing config with no `deployJobClient`
now explains the cause (the service provisions via a container-based `kubectl`/`kustomize`/`helm`
render) and names the remedies per runtime (a self-hosted runner pool, `LOCAL_DEPLOY_RUNTIME`, or
the Cloudflare `DeployContainer` binding) or switching the service to raw manifests. The board's
`AgentFailureCard` now shows a "Set up environments" action on `environment`-kind failures that
deep-links straight to Infrastructure → Test environments. In local mode — where the deploy
runtime is an env-var rather than a UI connection — the banner also surfaces the concrete `.env`
fix inline (`LOCAL_DEPLOY_RUNTIME` + `LOCAL_DEPLOY_HARNESS_ENTRY` / `LOCAL_DEPLOY_IMAGE`).
