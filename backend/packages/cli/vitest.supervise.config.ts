import { defineConfig } from 'vitest/config'

// The `cat-factory supervise` integration suite, kept in its own config because of where it has to
// RUN. It drives the built CLI as its own process (`dist/bin.js`) against a real child, which is the
// only way to catch the failure it exists to prevent: an `unref`'d poll timer let the supervisor
// exit 0 the moment its child died, and in-process that is invisible because vitest itself holds the
// event loop open. So it needs a BUILD — but, unlike the k3s suite it would otherwise share
// `vitest.integration.config.ts` with, it needs no cluster, no Docker and no network. Running it
// under the k8s lane would gate a cluster-free suite behind a k3d spin-up and, worse, behind the
// `kubernetes` path filter — so a change to `supervise*.ts` would never run it at all.
//
// Self-skips when `dist/` is absent, mirroring the `K8S_IT_*` / `DATABASE_URL` self-skip pattern.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/supervise.it.spec.ts'],
    // Real process starts, a boot-grace window and a restart cycle: generous, but it settles in
    // seconds. The per-assertion budgets inside the spec are what actually bound it.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
})
