---
'@cat-factory/app': minor
'@cat-factory/contracts': minor
'@cat-factory/server': patch
'@cat-factory/local-server': patch
---

Collapse the Infrastructure settings into one flat backend list per tab. The "Agent
containers" and "Test environments" tabs each now show a single radio list of concrete
destinations (built-in · Kubernetes cluster · custom HTTP pool/provider) with a one-line
description, instead of stacking a "where it runs" radio above a separate "runner/environment
backend" dropdown. Selecting a cluster/pool reveals its connect form inline.

Adds a low-config **Local Kubernetes (k3s)** preset (local mode, agent containers) that
prefills the Kubernetes runner form for a local k3s cluster — the operator only pastes a
ServiceAccount token. To support it, the Kubernetes runner form gains the
`insecureSkipTlsVerify` toggle, and the infrastructure capability descriptor surfaces the
local deployment's executor image (`suggestedExecutorImage`, from `LOCAL_HARNESS_IMAGE`) so
the preset's image is prefilled. No backend behavior change was needed — the Kubernetes
apiserver validator already permits loopback hosts and self-signed TLS.

Also moves the manifest editor's "currently stored secrets" indication next to the secret
inputs so it's clear whether a value is already saved.

BREAKING (pre-1.0, internal): removes the `settings.providerConnection.backend.*` and
`settings.providerConnection.advancedManifest.*` i18n keys (the old in-form backend
dropdown + collapsed-manifest disclosure are gone).
