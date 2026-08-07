/// <reference types="@cloudflare/vitest-pool-workers/types" />
import type { GatekeeperEnv } from '../src/env'

// The `cloudflare:test` module (and the `SELF` binding the suite drives the Worker through) is
// declared by the pool's own `/types` entry, which the bare package name does not resolve to.
//
// The merge below is the second half: vitest-pool-workers types `env` as the ambient
// `Cloudflare.Env` that `wrangler types` would generate, and this Worker's bindings are declared
// in `src/env.ts` instead, so fold them in rather than keeping a second copy that could disagree
// with the one the source reads.
declare global {
  namespace Cloudflare {
    interface Env extends GatekeeperEnv {}
  }
}
