---
'@cat-factory/integrations': patch
---

Fix Kubernetes provisioning auto-detection missing manifests nested under a `deploy/`
or `deployment/` wrapper.

`findKubernetesRoot` only inspected each candidate directory directly, so a standard
helm/kustomize layout that lives one level deeper (e.g. `deployment/k8s/{base,overlays}`,
as in `kibertoad/simpler-service3`) was reported as `infraless`. The detector now descends
one level into a `k8s` / `kubernetes` / `manifests` child of any candidate wrapper dir and
evaluates that as the manifest root, so the nested overlay tree, renderer, namespace, and
image overrides are detected correctly.
