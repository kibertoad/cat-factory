---
'@cat-factory/app': patch
'@cat-factory/cli': patch
---

Surface why the Kubernetes connect button is disabled, and align the `cat-factory k3s` CLI
guidance with the actual form field names.

- The Kubernetes connect forms (`KubernetesEngineForm`, `KubernetesRunnerForm`,
  `KubernetesEnvironmentForm`) now render a red hint next to the disabled **Connect** button
  listing the mandatory fields that are still empty (or, where applicable, the format/range
  issue), so a dead button explains itself instead of leaving the user guessing.
- `cat-factory k3s`'s connection summary now names the fields exactly as the Local k3s form
  labels them: paste the token into the **"ServiceAccount token"** field (was "API token"),
  and set **"Environment URL source" → "Ingress host template"** with the **"Host template"**
  value (was a single "Ingress host template" line).
