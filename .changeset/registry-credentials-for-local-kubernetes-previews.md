---
'@cat-factory/integrations': minor
'@cat-factory/kernel': minor
'@cat-factory/cli': patch
---

Wire a registry pull credential into per-PR Kubernetes namespaces on a local cluster.

A per-PR namespace is created seconds before the manifests are applied, so no pull secret can be
waiting in it, and a private package was therefore unpullable with no configuration path out. When
the apiserver names the machine the platform runs on, a provision now writes the run's own git
credential into the namespace as a `dockerconfigjson` Secret and attaches it to the service
accounts the manifests run as. Nothing is configured for it; remote clusters are unchanged.

The gate is kernel's new `isLocalMachineHost`, which the CLI's own `looksLocalCluster` composes
too: it covers loopback plus the spellings a local kubeconfig actually contains (k3d's wildcard
`0.0.0.0`, the Docker Desktop host aliases) and still refuses the RFC1918 space.

Two bounds are stated rather than implied. The credential is the provision's own short-lived git
token, so it expires about an hour later and nothing renews it: a pull after that needs a
re-provision. And on the container-render path a kustomize overlay that declares its own namespace
is skipped, because the namespace is resolved inside the deploy container and there is nowhere to
place a Secret before dispatch. Both land in the provisioning log as a `registry-auth` step, as
does every other reason no credential was wired.

`AsyncProvisionCapability.buildProvisionJob` returns a `Promise` now, so the container-render path
can prepare the cluster before dispatch. Only the Kubernetes adapter implements it.
