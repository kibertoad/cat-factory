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
import { Journal } from '../src/journal.ts'
import {
  formatPreflightFailure,
  formatPreflightLine,
  type PreflightReport,
  runPreflight,
} from '../src/preflight.ts'
import { PREREQUISITES } from '../src/prerequisites.ts'
import { createClient } from '../src/publicApi.ts'
import { resolveRunId, WorldStore } from '../src/world.ts'

export type Harness = {
  config: AcceptanceConfig
  /** The published SDK, pointed at the deployment. The suite's primary surface. */
  client: CatFactoryClient
  /** The setup calls and preflight probes `/api/v1` does not serve. See `src/appApi.ts`. */
  app: AppApi
  world: WorldStore
  /** The pass's durable progress record. Every spec's observations land here. */
  journal: Journal
}

let cached: Harness | null = null

export function harness(phase: string): Harness {
  if (cached) {
    cached.journal.enterPhase(phase)
    return cached
  }
  const config = requireConfig(process.env)
  const runId = resolveRunId(process.env, config.stateDir)
  const world = new WorldStore(config.stateDir, runId)
  cached = {
    config,
    client: createClient(config),
    app: new AppApi({ baseUrl: config.baseUrl, workspaceId: config.workspaceId }),
    world,
    journal: new Journal(world.dir, runId, phase),
  }
  // Printed on every spec file's first use because an operator whose run dies in spec 03 needs
  // this value to resume and has no other way to recover it.
  console.log(
    `\nacceptance run ${runId} against ${config.baseUrl}\n` +
      `  ledger:  ${world.path}\n` +
      `  journal: ${cached.journal.path}\n` +
      `  watch:   pnpm --filter @cat-factory/acceptance run status ${runId}\n` +
      `  resume:  ACCEPTANCE_RUN_ID=${runId}\n`,
  )
  cached.journal.record('phase-started', `entered ${phase}`)
  return cached
}

let preflight: Promise<PreflightReport> | null = null

/**
 * Evaluate every prerequisite, or reuse this file's already-evaluated report.
 *
 * Memoised per module graph, so it costs one pass of cheap reads per spec FILE rather than one
 * per test. Re-running it in each file is the point rather than an accident: a resumed pass that
 * starts at spec 02 must still refuse a deployment whose model was unwired since yesterday, and a
 * gate that only spec 00 runs is a gate the resume path skips entirely.
 */
export function preflightReport(): Promise<PreflightReport> {
  if (preflight) return preflight
  const { config, client, app, world, journal } = harness('preflight')
  preflight = runPreflight(
    PREREQUISITES,
    {
      config,
      client,
      app,
      serviceTitles: Object.values(serviceTitles(config.namePrefix)),
      hasBootstrappedServices: Boolean(world.value.backend ?? world.value.frontend),
    },
    (result) => {
      journal.record('prerequisite', formatPreflightLine(result).trim())
      console.log(formatPreflightLine(result))
    },
  )
  return preflight
}

/**
 * The gate every spec that spends anything mounts in `beforeAll`.
 *
 * It throws ONE error naming every unsatisfied prerequisite (`preflight.ts` builds it), which is
 * what "fail loudly" has to mean for a suite whose alternative failure mode is an afternoon of
 * real spend ending in a message about something else.
 */
export async function assertPrerequisites(): Promise<void> {
  const failure = formatPreflightFailure(await preflightReport())
  if (failure) throw new Error(failure)
}

/** Board titles, derived so the ledger, the specs and the board cannot disagree about them. */
export function serviceTitles(prefix: string): { backend: string; frontend: string } {
  return { backend: `${prefix} Catalog API`, frontend: `${prefix} Catalog Web` }
}
