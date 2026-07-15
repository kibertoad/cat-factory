---
'@cat-factory/integrations': minor
'@cat-factory/server': minor
---

Make Kubernetes provisioning auto-detection work across monorepo layouts, and stop it
false-positive-detecting a service's source directory as a deploy target.

The detector (`detectKubernetesProvisioning`) previously treated ANY YAML with a
`kind` + `apiVersion` as a Kubernetes manifest, and only looked for shared per-service
manifest slices as immediate children of a short, flat root list (`deploy`/`k8s`/
`kubernetes`/`manifests`/…). On a real Kustomize monorepo (source nested two levels deep,
a Backstage `catalog-info.yaml` in every service dir, manifests under
`deployment/k8s/base/services/<svc>` + `overlays/<env>/<svc>`) that produced two failures:
it confidently recommended deploying the service's SOURCE folder as "raw manifests" (the
`catalog-info.yaml` decoy), and it never found the real shared manifests. This reworks the
heuristics to be layout-agnostic while staying deterministic and checkout-free:

- **Manifest classifier.** A YAML doc counts as a manifest only when its API group is
  Kubernetes-shaped — core / `*.k8s.io` / kustomize / a known operator-CRD group — and NOT
  on a non-Kubernetes denylist (Backstage `backstage.io`, …). This kills the source-dir
  false positive across every Backstage-catalogued repo, and correctly disambiguates a
  Kustomize `Component` from a Backstage `Component`.
- **Kustomize Component awareness.** A `kind: Component` slice isn't independently
  deployable; when it's the chosen source the detector resolves and recommends the overlay
  that aggregates it (via `components:`), or keeps it with a clear warning when none does.
- **Generalized monorepo slice discovery.** A bounded, layered breadth-first search descends
  from a broadened set of deploy roots (adds `deployment`/`ops`/`gitops`/`argocd`/`flux`/…)
  THROUGH the structural layers (`base`/`services`/`apps`/`overlays/<env>`/`components`) to
  find THIS service's slice however deep it's nested, matching by exact / case-insensitive /
  affix (`<prefix>-<svc>`) name. Only the service's own matched slice(s) are surfaced —
  no more flooding the picker with every sibling — and a same-named terraform `infra/<svc>`
  sibling is not mistaken for a manifest slice.
- **Escape hatches** (deployment `ENVIRONMENTS_DETECTION_CONVENTIONS`): `manifestDirs` adds
  house-named deploy roots, and `serviceManifestPaths` pins explicit `{service}`/`{env}`
  path templates that resolve the service→manifests mapping deterministically before the
  heuristic search — a one-line config that makes an exotic layout resolve exactly.

Existing behaviour for colocated / simple layouts is unchanged. The stack-recipes pilot
golden was regenerated: the consumer's Backstage `catalog-info.yaml` no longer produces a
spurious "Kubernetes manifests also exist" note (the intended, documented drift).
