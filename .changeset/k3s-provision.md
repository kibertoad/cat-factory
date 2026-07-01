---
'@cat-factory/cli': minor
---

`cat-factory k3s` now provisions on your behalf (guided-setup slice 2): after the probe,
it creates (or reuses) a local k3d/kind cluster, applies a least-privilege ServiceAccount

- RBAC, mints a long-lived token, reads the apiserver URL, and prints the values to wire
  into the Local k3s environment handler. Every mutating step is behind an explicit confirm
  (skipped by `--yes`); the sudo `k3s` install is still only ever printed. The `HostShell`
  seam gained an `input` option so the RBAC manifest is piped to `kubectl apply -f -` without
  touching disk. Also refreshes the scaffold `@cat-factory/app` pin to `^0.64.0`.
