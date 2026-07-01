import { defineConfig } from 'vitest/config'

// The k3s guided-setup integration suite drives the CLI's REAL probe + provisioning logic
// (`probeHost` / `provisionCluster` over the process-backed `createNodeShell()`) against a REAL
// k3d (k3s-in-Docker) cluster — the same cluster the `test-k8s` CI job stands up — so the
// idempotent re-run behaviour the unit tests only mock is validated for real: a stable
// long-lived ServiceAccount token across re-provisions (no rotation), `kubectl apply` reconcile
// of the namespace/SA/RBAC, and no duplicate resources. It self-skips when no reachable LOCAL
// cluster is on the current kubeconfig context (see the suite's skip guard), mirroring the
// `K8S_IT_*` / `DATABASE_URL` self-skip pattern used elsewhere in the repo.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.it.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One shared cluster, one provisioned namespace — run serially to keep the mutating
    // provisioning steps isolated.
    fileParallelism: false,
  },
})
