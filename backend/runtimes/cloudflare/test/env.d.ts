import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { Env } from '../src/infrastructure/env'

// Augment the `cloudflare:test` module's env with our Worker bindings plus the
// migrations array injected via miniflare bindings in vitest.config.ts.
declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[]
    TEST_TELEMETRY_MIGRATIONS: D1Migration[]
    TEST_SANDBOX_MIGRATIONS: D1Migration[]
  }
}
