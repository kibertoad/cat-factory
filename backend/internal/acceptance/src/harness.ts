// What every scenario is handed: the configuration, the SDK client, the ledger, the journal and the
// pass's personal-subscription unlock, built ONCE for the pass.
//
// Once is the whole point of this file, and it used to be impossible. Vitest gave each of the five
// spec files its own module graph in its own worker, so this was memoised per FILE, and the two
// facts that cannot be per file (the pass's RUN ID, which is the ledger's key, and the operator's
// password) had to be settled in a `globalSetup` hook and handed over vitest's RPC channel. In one
// process they are ordinary values, resolved by `runAcceptance.ts` and passed in as arguments: a run
// id cannot go missing, so nothing here has to refuse its absence.
//
// The ledger stays exactly as it was. It is not a vitest workaround: it survives across
// INVOCATIONS, which no runner gives you, and facts moving in-process does not remove the need to
// write down what a pass created.

import type { CatFactoryClient, PrReportRunProvider } from '@cat-factory/sdk'
import { type AcceptanceConfig } from './config.ts'
import { DeploymentApi } from './deploymentApi.ts'
import { serviceTitles } from './instructions.ts'
import { Journal } from './journal.ts'
import type { PersonalUnlock } from './personalUnlock.ts'
import {
  createPrerequisiteGate,
  formatPreflightLine,
  type PreflightReport,
  type PrerequisiteGate,
  runPreflight,
} from './preflight.ts'
import { PREREQUISITES } from './prerequisites.ts'
import { createClient, createPassClient } from './publicApi.ts'
import { type IssueApi, ISSUE_APIS } from './vcsIssues.ts'
import { findPassesNaming, WorldStore } from './world.ts'

export type Harness = {
  config: AcceptanceConfig
  /** The published SDK, pointed at the deployment. The suite's primary surface. */
  client: CatFactoryClient
  /** The two deployment ROOT reads, which take no credential. See `src/deploymentApi.ts`. */
  deployment: DeploymentApi
  world: WorldStore
  /** The pass's durable progress record. Every scenario's observations land here. */
  journal: Journal
  /**
   * The pass's personal-subscription unlock, held for the life of the process and written nowhere.
   * Handed to `fileAndDrive`; the client already carries whatever it holds onto every request. It is
   * filled by the ONE up-front ask in `runAcceptance.ts` when the pinned preset needs one, and stays
   * empty (and lazy) otherwise.
   */
  unlock: PersonalUnlock
  /**
   * The pass's prerequisite gate: the driver's refusal before every gated scenario, and the report
   * scenario's own evaluation. ONE object, so the two cannot come to evaluate different things.
   */
  prerequisites: PrerequisiteGate
  /**
   * Operator output, the SAME function the driver logs through (`ScenarioRunnerDeps.log`).
   *
   * Injected rather than `console.log` reached for here, and the reason is the fourteen prerequisite
   * verdict lines: they are the only output between a scenario opening and its first step, they are
   * printed twice per pass on a resumed one, and reached for on the global console they were the one
   * line of a pass that did not go through the seam. What that costs is not hypothetical in one
   * direction: a second sink (a file, a structured tee for an afternoon-long pass) is one change here
   * and would have silently missed exactly those lines.
   */
  log: (message: string) => void
}

/** Everything an evaluation of the prerequisites reads. The harness, minus what only a scenario needs. */
type PrerequisiteInputs = Pick<Harness, 'config' | 'deployment' | 'world' | 'journal' | 'log'> & {
  /**
   * The FAST-REFUSING client, deliberately not `Harness.client`.
   *
   * The one field the gate does not share with a scenario, and the only reason this type is no
   * longer a plain `Pick`. A prerequisite runs before the pass has created anything, so a
   * deployment that is not answering is a verdict to print rather than an outage to sit through:
   * `publicApi.ts` owns that argument and both halves of it.
   */
  client: CatFactoryClient
}

/**
 * Build the pass's harness.
 *
 * Wiring only: every judgement it would otherwise make lives in the modules it composes. The journal
 * opens on the `suite` phase and the driver enters a scenario's phase as that scenario opens, which
 * is what keeps every line filed under the scenario that wrote it.
 */
export function buildHarness(options: {
  config: AcceptanceConfig
  runId: string
  unlock: PersonalUnlock
  log: (message: string) => void
}): Harness {
  const { config, runId, unlock, log } = options
  const world = new WorldStore(config.stateDir, runId)
  const shared = {
    config,
    deployment: new DeploymentApi({ baseUrl: config.baseUrl }),
    world,
    journal: new Journal(world.dir, runId),
    log,
  }
  // Named, because the gate closes over exactly these and the harness closes over the gate: taking
  // the whole `Harness` would be a cycle, and `PrerequisiteInputs` says which half an evaluation
  // actually reads.
  const inputs: PrerequisiteInputs = { ...shared, client: createClient(config, unlock) }
  return {
    ...shared,
    // The two clients differ only in how long a call waits on a deployment that is not answering,
    // and they are built here rather than shared because the answer differs by what is at stake:
    // an hour of agent work on this side, nothing at all on the gate's.
    client: createPassClient(config, unlock),
    unlock,
    prerequisites: createPrerequisiteGate(() => evaluatePrerequisites(inputs)),
  }
}

/**
 * Evaluate every prerequisite, FRESH.
 *
 * Deliberately not memoised, which is the one thing about this that changed with the runner. Under
 * vitest it was memoised per module graph, and a module graph was one spec FILE, so the gate really
 * ran once per scenario; a module-level memo in ONE process would quietly turn that into once per
 * pass.
 * That matters twice over. It is rule 0 (a resumed pass starts wherever it stopped, so a check only
 * the first scenario runs is a check the resume path skips), and a pass takes an AFTERNOON: a
 * workspace that went over budget during the feature runs, or a model unwired between them, is
 * refused before the next scenario spends rather than discovered as a run that stalls.
 *
 * The one place a report is REUSED is the seam between the preflight report and the gate that runs
 * seconds later with nothing in between; `createPrerequisiteGate` owns that and nothing else does.
 */
function evaluatePrerequisites(inputs: PrerequisiteInputs): Promise<PreflightReport> {
  const { config, client, deployment, world, journal, log } = inputs
  return runPreflight(
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
      // The other half of that comparison: when a leftover frame is NOT this pass's, the remedy is
      // the run id of the pass it does belong to, and the ledgers on disk are the only place that
      // mapping exists. Read at refusal time rather than up front, so a satisfied pass reads no
      // ledger but its own.
      passesNaming: (serviceIds) =>
        findPassesNaming(config.stateDir, serviceIds, world.value.runId),
      issueApiFor: (provider) => issueApiFor(config, provider),
    },
    {
      // The DEPLOYMENT, so a thrown probe is described against it rather than as undici's `fetch
      // failed`. Even `cluster-connection` qualifies: it probes k3s THROUGH the backend, so its
      // transport failures are the backend's too. `issue-credential` also reaches the provider's own
      // API, which no one context can name beside this one, so it describes that half itself; see
      // `PreflightOptions.probe`.
      probe: { subject: 'the cat-factory backend', target: config.baseUrl },
      onResult: (result) => {
        journal.record('prerequisite', formatPreflightLine(result).trim())
        log(formatPreflightLine(result))
      },
    },
  )
}

/**
 * The reporter's issue client for a provider, or null when this suite cannot address that provider.
 *
 * The ONE construction site, shared by the `issue-credential` gate and the intake scenario, so the
 * gate probes with the same credential and against the same base the scenario files with. Two
 * builders would let a pass pass its gate and then file somewhere else.
 */
export function issueApiFor(
  config: AcceptanceConfig,
  provider: PrReportRunProvider,
): IssueApi | null {
  const build = ISSUE_APIS[provider]
  return build ? build({ token: config.vcs.token, apiBaseUrl: config.vcs.apiBaseUrl }) : null
}
