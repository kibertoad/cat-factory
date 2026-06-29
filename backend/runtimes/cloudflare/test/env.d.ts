/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { D1Migration } from '@cloudflare/vitest-pool-workers'
import type { Env as WorkerEnv } from '../src/infrastructure/env'

// vitest-pool-workers v4 types the `env` exported from `cloudflare:test` as the
// ambient `Cloudflare.Env` (the type `wrangler types` generates). Populate it by
// merging into that interface: the Worker's own bindings (declared in wrangler.toml
// / src/infrastructure/env.ts) plus the migration arrays injected via miniflare
// bindings in vitest.config.ts. Interface-declaration merging folds these onto the
// empty `Cloudflare.Env` shipped by @cloudflare/workers-types.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: D1Migration[]
      TEST_TELEMETRY_MIGRATIONS: D1Migration[]
      TEST_SANDBOX_MIGRATIONS: D1Migration[]
      TEST_MIGRATIONS_PROVISIONING: D1Migration[]
    }
  }
}
