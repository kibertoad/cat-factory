import { configDefaults, defineConfig } from 'vitest/config'

// Default (unit) test run for the CLI package. The k3s guided-setup INTEGRATION suite
// (`*.it.spec.ts`) drives the real probe + provisioning logic over a process-backed HostShell
// against a live k3d/Kubernetes apiserver, is slow, and needs a reachable local cluster, so it
// is excluded here and runs only via the dedicated `vitest.integration.config.ts` (the
// `test:integration` script). Everything else — the pure-unit `*.test.ts` files (args, secrets,
// the k3s pure planners, the handler-shape/contract guard) — runs as normal.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.it.spec.ts'],
  },
})
