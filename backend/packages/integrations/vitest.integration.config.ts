import { defineConfig } from 'vitest/config'

// The Kubernetes integration suite drives the two native K8s backends
// (KubernetesRunnerTransport + KubernetesEnvironmentProvider) against a REAL Kubernetes
// apiserver — a k3d (k3s-in-Docker) cluster locally and in CI — so the apiserver
// behaviours the unit tests only mock (pod-proxy round-trip, server-side apply, the
// LoadBalancer status shape, real 404/409 semantics) are validated for real. It is slow
// and needs a cluster, so it is kept out of the default unit run (see `vitest.config.ts`)
// and given generous timeouts. It self-skips when the `K8S_IT_*` env is unset (see
// `test-support/cluster.ts`), mirroring the DATABASE_URL / Docker self-skip pattern used
// elsewhere in the repo.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/modules/kubernetes/**/*.it.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One cluster, shared namespaces — run the suites serially to keep them isolated.
    fileParallelism: false,
  },
})
