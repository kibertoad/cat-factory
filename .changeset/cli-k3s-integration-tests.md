---
'@cat-factory/cli': patch
---

Add a configurable token-read poll budget to the `cat-factory k3s` provisioner: `ProvisionDeps.tokenReadAttempts` (default `DEFAULT_TOKEN_READ_ATTEMPTS` = 20, i.e. 10s) lets a caller wait longer for a freshly-applied ServiceAccount-token Secret to populate. The interactive default is unchanged (still fails fast); the new k3d integration suite raises it so a busy CI cluster's token controller can't flake the run.

Also test/CI only: a k3d integration suite for the guided setup that drives the CLI's real probe + provisioning logic against the `test-k8s` cluster, validating the idempotent "already set up before" re-run behaviour (stable long-lived token across re-provisions, `kubectl apply` reconcile, no duplicate resources). Runs in the existing `test-k8s` CI job (also gated on `host-shell.ts`, whose real `createNodeShell()` this suite alone exercises); self-skips when no reachable local cluster is present.
