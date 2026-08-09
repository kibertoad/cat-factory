// Shared setup for the acceptance specs.
//
// Memoised per MODULE GRAPH, which is once per spec FILE rather than once per run: vitest gives
// every test file its own graph even when they share a worker. That is why the facts specs pass
// to each other live in the on-disk ledger (`src/world.ts`) and this only memoises what is cheap
// to rebuild, and it is also why each file re-reads the ledger on construction rather than
// trusting an object a previous file left behind.

import type { CatFactoryClient } from '@cat-factory/sdk'
import { AppApi } from '../src/appApi.ts'
import { type AcceptanceConfig, requireConfig } from '../src/config.ts'
import { createClient } from '../src/publicApi.ts'
import { resolveRunId, WorldStore } from '../src/world.ts'

export type Harness = {
  config: AcceptanceConfig
  /** The published SDK, pointed at the deployment. The suite's primary surface. */
  client: CatFactoryClient
  /** The three setup calls `/api/v1` deliberately does not serve. See `src/appApi.ts`. */
  app: AppApi
  world: WorldStore
}

let cached: Harness | null = null

export function harness(): Harness {
  if (cached) return cached
  const config = requireConfig(process.env)
  const runId = resolveRunId(process.env)
  const world = new WorldStore(config.stateDir, runId)
  cached = {
    config,
    client: createClient(config),
    app: new AppApi({ baseUrl: config.baseUrl, workspaceId: config.workspaceId }),
    world,
  }
  // Printed on every spec file's first use because an operator whose run dies in spec 03 needs
  // this value to resume and has no other way to recover it.
  console.log(
    `\nacceptance run ${runId} against ${config.baseUrl}\n` +
      `  ledger: ${world.path}\n` +
      `  resume with: ACCEPTANCE_RUN_ID=${runId}\n`,
  )
  return cached
}

/** Board titles, derived so the ledger, the specs and the board cannot disagree about them. */
export function serviceTitles(prefix: string): { backend: string; frontend: string } {
  return { backend: `${prefix} Catalog API`, frontend: `${prefix} Catalog Web` }
}
