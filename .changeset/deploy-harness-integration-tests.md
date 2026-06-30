---
'@cat-factory/deploy-harness': patch
---

Add a k3d integration suite for the deploy harness that drives `handleDeploy` against a real
Kubernetes apiserver with the real kubectl/kustomize CLIs: clone → namespace → secret
injection (a `Secret` and a kustomize `generatorEnvFile` content-hash rewrite) → kustomize
image/namespace edits → `kubectl apply` → rollout → URL discovery, plus the slow-rollout
(`provisioning`) and invalid-manifest failure/redaction paths and the `POST /jobs` + `GET
/jobs/{id}` server contract. It reuses the existing `test-k8s` job's k3d cluster + `K8S_IT_*`
connection and is path-gated so it runs only when the harness changes. Test/CI only — no
runtime/image behaviour changes.
