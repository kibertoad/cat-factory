---
'@cat-factory/integrations': minor
---

Self-hosted runner pools: expose the dispatch `kind` + provisioning hints as
first-class manifest template variables.

`HttpRunnerPoolProvider` now surfaces three more `{{input.*}}` variables to a
manifest's request templates, alongside the existing `{{input.jobId}}` /
`{{input.job}}`:

- `{{input.kind}}` — the harness route the job targets (`run`, `blueprint`, `spec`,
  `explore`, `bootstrap`, `ci-fix`, `resolve-conflicts`, `merge`, `on-call`, `test`,
  `fix-tests`). The values map 1:1 to the harness route names, so a transparent
  proxy can route straight to a per-kind endpoint with `pathTemplate:
"/{{input.kind}}"` instead of parsing the embedded `{{input.job}}` JSON.
- `{{input.instanceType}}` / `{{input.cloudProvider}}` — the provisioning hints the
  transport stamps on when the service pins a size/provider, so a self-provisioning
  pool (k8s/Nomad) can map them to a node selector / resource request / queue
  declaratively in the manifest.

These were already carried inside `{{input.job}}`; exposing them flat lets a
path/query/header template route and size without decoding the job JSON. Backward
compatible — existing manifests that forward `{{input.job}}` are unaffected. The
operator/integrator playbook (`docs/runner-pool-integration.md`) is fully rewritten
to match current behaviour (all kinds incl. bootstrap route to a pool; only the
synchronous repo scan stays Cloudflare-only).
