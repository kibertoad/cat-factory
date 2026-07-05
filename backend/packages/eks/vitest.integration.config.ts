import { defineConfig } from 'vitest/config'

// The EKS integration suite drives the two EKS backends (EksRunnerTransport +
// EksEnvironmentProvider) against a REAL Kubernetes apiserver fronted by an AWS EKS-compatible
// API — a floci-emulated EKS cluster (floci starts a real k3s container per cluster) in CI, or
// any reachable EKS/k8s apiserver locally. It validates the pod-proxy round-trip, server-side
// apply, and 404/409 semantics against a real server — exactly like the Kubernetes integration
// suite it mirrors. It is slow and needs a cluster, so it is kept out of the default unit run
// (see `vitest.config.ts`) and given generous timeouts. It self-skips when the `EKS_IT_*` env is
// unset (see `test-support/eks-cluster.ts`), mirroring the K8S_IT_* / DATABASE_URL self-skip.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.it.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One cluster, shared namespaces — run the suites serially to keep them isolated.
    fileParallelism: false,
  },
})
