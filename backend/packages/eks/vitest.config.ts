import { configDefaults, defineConfig } from 'vitest/config'

// Default (unit) test run for the EKS package. The EKS INTEGRATION suites (`*.it.spec.ts`)
// drive a REAL apiserver — a floci-emulated EKS cluster (real k3s behind the AWS EKS API) in
// CI — are slow, and need `EKS_IT_*` env, so they are excluded here and run only via the
// dedicated `vitest.integration.config.ts` (the `test:integration` script). The pure-unit
// tests (the SigV4/STS token minter golden vector, the contract round-trip) run as normal.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.it.spec.ts'],
  },
})
