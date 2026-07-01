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

  Hardening: cluster creation runs under a 5-minute watchdog (the default 10s would kill the
  image pull); the RBAC no longer grants cluster-wide `list`/`watch` on `secrets`/
  `serviceaccounts` (which would let the token read every ServiceAccount token — effectively
  cluster-admin); `--yes` refuses to auto-provision a reachable cluster that doesn't look local
  (guarding a kubeconfig pointed at a shared/remote cluster) and the confirm names the target
  context + apiserver; commands target an explicit `--context` instead of mutating the user's
  global current-context; a create that fails on the apiserver port surfaces a collision hint;
  and the `0.0.0.0` apiserver bind address is normalized to `127.0.0.1`.
