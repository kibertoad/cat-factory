import { configDefaults, defineConfig } from 'vitest/config'

// Default (unit) test run for the integrations package. The Kubernetes INTEGRATION suites
// (`*.it.spec.ts`) drive a real k3d/Kubernetes apiserver, are slow, and need a cluster +
// `K8S_IT_*` env, so they are excluded here and run only via the dedicated
// `vitest.integration.config.ts` (the `test:integration` script). Everything else — the
// pure-unit `*.test.ts`/`*.spec.ts` files, including the Kubernetes adapters' mocked-fetch
// unit tests — runs as normal.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.it.spec.ts'],
  },
})
