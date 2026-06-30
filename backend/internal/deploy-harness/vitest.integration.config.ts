import { defineConfig } from 'vitest/config'

// The deploy-harness INTEGRATION suite drives handleDeploy against a REAL Kubernetes
// apiserver — a k3d (k3s-in-Docker) cluster locally and in CI (the SAME cluster the
// `integrations` Kubernetes suite uses) — with the real kubectl/kustomize CLIs, so the
// render→apply→roll-out→resolve-URL path the unit tests can only mock is validated for
// real. It is slow and needs a cluster + the k8s CLIs, so it is kept out of the default
// unit run (`vitest.config.ts` includes only `test/*.test.ts`) and given generous timeouts.
// It self-skips when the `K8S_IT_*` env is unset (see `test/cluster.ts`), mirroring the
// DATABASE_URL / Docker self-skip pattern used elsewhere in the repo.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.it.spec.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One cluster, shared namespaces — run the specs serially to keep them isolated.
    fileParallelism: false,
  },
})
