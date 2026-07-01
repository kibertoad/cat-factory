---
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/app': minor
---

Broaden the provisioning auto-detector and make it monorepo-aware with user-selectable candidates.

- **More layouts recognized.** Compose detection now covers override/env-variant names
  (`compose.override.*`, `docker-compose.override.*`, `docker-compose.{prod,dev}.*`) and files nested
  under `deploy/` / `docker/` / `.docker/` / `compose/`. Kubernetes detection adds common roots
  (`charts`, `chart`, `helm`, `kustomize`, `.kube`, `infra`, `infrastructure`, `infra/manifests`,
  `deploy/k8s`, `deploy/kubernetes`, `config/k8s`, `ops`, `gitops`, `.deploy`) and nested wrapper
  subdirs (`overlays`, `base`, `helm`, `charts`, `kustomize`).
- **Monorepo-aware.** When scoped to a service subdirectory, the detector checks both the colocated
  service folder AND the repo's root shared-deploy dirs (`deploy/<svc>`, `k8s/<svc>`,
  `manifests/services/<svc>`, `apps/<svc>`, …), matching the service's slice by its directory basename.
- **Choose instead of silent auto-pick.** The recommendation now surfaces `serviceDirCandidates`
  (which root-shared monorepo slice), `manifestRootCandidates` (which k8s root when several resolve),
  and `composeServiceCandidates` (which compose service) alongside the existing overlay candidates, each
  rendered as a selectable chip in the service inspector's "Detect from repo" panel.

The recommendation's new fields are optional; nothing is persisted by detection. The compose service key
is advisory (surfaced as a candidate/note only) — it is not written onto the service provisioning.
