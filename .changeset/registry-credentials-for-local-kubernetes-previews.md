---
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
---

Wire a registry pull credential into per-PR Kubernetes namespaces on a local cluster.

A per-PR namespace is created seconds before the manifests are applied, so no pull secret can be
waiting in it, and a private package was therefore unpullable with no configuration path out. When
the apiserver is a loopback address, a provision now writes the run's own git credential into the
namespace as a `dockerconfigjson` Secret and attaches it to the service accounts the manifests run
as. Nothing is configured for it; remote clusters are unchanged.

`AsyncProvisionCapability.buildProvisionJob` returns a `Promise` now, so the container-render path
can prepare the cluster before dispatch. Only the Kubernetes adapter implements it.
