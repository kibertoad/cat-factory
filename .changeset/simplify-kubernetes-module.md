---
'@cat-factory/integrations': patch
---

Simplify the Kubernetes integration module internally (behaviour-preserving).

- Remove the unused `isSupportedKind()` export from `kubernetes-environment.logic.ts`.
- Drop the `KubernetesEnvironmentProvider`'s private `renderImage()`, which duplicated the
  shared `renderTemplate()`, and derive the per-PR namespace + template vars once through a
  single `provisionContext()` helper reused by `provision`, `buildProvisionJob`, and
  `finalizeProvision`.
- Collapse the repeated apiserver GET/parse and "by name, else first in list" logic in the
  status/URL reads behind two small `getJson`/`getByNameOrFirst` helpers.
- Share the custom-TLS runtime-support check between the runner and environment backends via
  a new `assertCustomTlsSupported()` in `kubernetes.logic.ts`.

No functional or wire-shape changes; covered by the existing unit suite.
