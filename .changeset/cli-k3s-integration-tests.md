---
---

Test/CI only: add a k3d integration suite for the `cat-factory k3s` guided setup that drives the CLI's real probe + provisioning logic against the `test-k8s` cluster, validating the idempotent "already set up before" re-run behaviour (stable long-lived token across re-provisions, `kubectl apply` reconcile, no duplicate resources). Runs in the existing `test-k8s` CI job; self-skips when no reachable local cluster is present.
