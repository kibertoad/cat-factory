// Shared setup for the acceptance specs.
//
// Memoised per MODULE GRAPH, which is once per spec FILE rather than once per run: vitest gives
// every test file its own graph even when they share a worker. That is why the facts specs pass
// to each other live in the on-disk ledger (`src/world.ts`) and this only memoises what is cheap
// to rebuild, and it is also why each file re-reads the ledger on construction rather than
// trusting an object a previous file left behind.

import type { CatFactoryClient } from '@cat-factory/sdk'
import { DeploymentApi } from '../src/deploymentApi.ts'
import { type AcceptanceConfig, requireConfig } from '../src/config.ts'
import { Journal } from '../src/journal.ts'
import { createPersonalUnlock, type PersonalUnlock } from '../src/personalUnlock.ts'
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
  /** The two deployment ROOT reads, which take no credential. See `src/deploymentApi.ts`. */
  deployment: DeploymentApi
  world: WorldStore
  /** The pass's durable progress record. Every spec's observations land here. */
  journal: Journal
  /**
   * The pass's personal-subscription unlock, held for the life of the process and written nowhere.
   * Handed to `fileAndDrive`; the client already carries whatever it holds onto every request.
   */
  unlock: PersonalUnlock
}

let cached: Harness | null = null

/**
 * Build the harness, or return this module graph's already-built one, WITHOUT touching the phase.
 *
 * The split from `harness` is what keeps the journal's phase owned by the specs. Everything a
 * pass records is filed under the phase last entered, and the phase answers the question the
 * journal exists for: which spec is this pass on. A shared helper that needed the harness and
 * entered a phase of its own to get it would re-file every line that followed under its own name.
 */
function currentHarness(): Harness {
  if (cached) return cached
  const config = requireConfig(process.env)
  const runId = resolveRunId(process.env, config.stateDir)
  const world = new WorldStore(config.stateDir, runId)
  // Built empty: nothing is asked for until a call is refused for want of it, so a workspace whose
  // models come from a provider API key never sees a prompt. Memoised with the harness rather than
  // per spec FILE by accident — each vitest file gets its own module graph, so a pass that spends
  // three specs is asked at most once per FILE that actually starts or answers a run.
  const unlock = createPersonalUnlock()
  cached = {
    config,
    unlock,
    client: createClient(config, unlock),
    deployment: new DeploymentApi({ baseUrl: config.baseUrl }),
    world,
    journal: new Journal(world.dir, runId),
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
  return cached
}

/** The harness, with every subsequent journal line filed under this spec. */
export function harness(phase: string): Harness {
  const built = currentHarness()
  built.journal.enterPhase(phase)
  return built
}

let preflight: Promise<PreflightReport> | null = null

/**
 * Evaluate every prerequisite, or reuse this file's already-evaluated report.
 *
 * Memoised per module graph, so it costs one pass of cheap reads per spec FILE rather than one
 * per test. Re-running it in each file is the point rather than an accident: a resumed pass that
 * starts at spec 02 must still refuse a deployment whose model was unwired since yesterday, and a
 * gate that only spec 00 runs is a gate the resume path skips entirely.
 *
 * Takes the harness WITHOUT entering a phase. The prerequisite lines belong to whichever spec's
 * `beforeAll` triggered them, which is what makes them readable afterwards; a phase of its own
 * here would also be the LAST one entered, so every bootstrap, feature and bugfix line for the
 * rest of the pass would file under it too.
 */
export function preflightReport(): Promise<PreflightReport> {
  if (preflight) return preflight
  const { config, client, deployment, world, journal } = currentHarness()
  preflight = runPreflight(
    PREREQUISITES,
    {
      config,
      client,
      deployment,
      serviceTitles: Object.values(serviceTitles(config.namePrefix)),
      // The IDS, not a "is this a resume" flag: `target-repos` compares each repository's linked
      // service against them, so a ledger holding only the backend cannot vouch for the frontend.
      adoptedServiceIds: [world.value.backend, world.value.frontend].flatMap((record) =>
        record ? [record.serviceId] : [],
      ),
    },
    {
      // What every probe here reaches, so a thrown one is described against it rather than as
      // undici's `fetch failed`. Even `cluster-connection` qualifies: it probes k3s THROUGH the
      // backend, so its transport failures are the backend's too.
      probe: { subject: 'the cat-factory backend', target: config.baseUrl },
      onResult: (result) => {
        journal.record('prerequisite', formatPreflightLine(result).trim())
        console.log(formatPreflightLine(result))
      },
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
