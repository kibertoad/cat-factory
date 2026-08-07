// Driving the Cloudflare OS GATEKEEPER against this deployment's real `/api/v1`.
//
// `@cat-factory/gatekeeper-worker` is a consumer of the public surface, and its own suite runs the
// assembled Worker in real workerd against a SCRIPTED cat-factory. That is what makes it hermetic,
// and it is also the one thing it cannot see: a fixture agrees with the package by construction, so
// a request shape the generated bindings and the SDK both consider correct fails for the first time
// against a real deployment. The generated table is regenerated from the same spec the deployment
// serves, which keeps the two from drifting on PATHS and SCOPES — never on what a body has to
// carry, which is where the first cut of that package's decision answerers were wrong.
//
// So this phase gives that suite a real origin. It seeds a workspace, points the Worker at this
// harness's own backend, and runs the package's `test/live` specs in workerd with no outbound
// service, so every call the Gatekeeper makes leaves the isolate and lands on the deployment.
//
// Two things follow from the shape of that, and both are deliberate:
//
//   - THE SPECS ARE THE ASSERTIONS. Unlike the SDK phases, there is nothing to compare and no
//     report to grade field by field: the claims are in the specs, where the workerd runtime and
//     the Cap'n Web session they need already exist. What this module grades is that the suite RAN
//     and that everything in it passed, which is why the JSON reporter's counts are read rather
//     than the exit code alone: a suite that collected nothing exits 0 and is not a pass.
//   - THE RUN PARKS ON PURPOSE. `startBackend` clears `E2E_DECISION_ON_STEPS` for every other
//     phase, so this one asks for the park PER WORKSPACE over the control channel. A Gatekeeper
//     whose whole reason to exist is answering parked runs cannot be smoketested against a
//     deployment that never parks one.

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ParityProblem, render, sameValue } from './parity.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The package whose live suite this phase runs. It owns the Worker, the policy and the specs. */
export const GATEKEEPER_PACKAGE = resolve(repoRoot, 'sdk/gatekeeper-worker')

export interface GatekeeperContext {
  baseUrl: string
  /** The control channel, for the per-workspace park profile. */
  controlPort: number
  workspaceId: string
  /** An `admin` key: the Worker's provisioning credential, which mints one key per actor. */
  adminKey: string
  /** A scratch directory the vitest JSON report is written into. */
  workDir: string
}

export interface GatekeeperReport {
  observations: Record<string, unknown>
  failures: string[]
}

/** What must hold whatever else the run observed. */
const GATEKEEPER_EXPECTED: Record<string, unknown> = {
  // The suite ran at all. A phase that reported nothing is not a pass, and a workerd pool that
  // failed to boot exits non-zero with an empty report rather than a failing test.
  suiteCollectedSpecs: true,
  suiteFailures: 0,
  suiteExitCode: 0,
}

/** Ask the deployment to park this workspace's runs on their first agent step. */
async function parkOnFirstStep(context: GatekeeperContext): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${context.controlPort}/fake-profile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: context.workspaceId,
      profile: { decisionOnSteps: [0] },
    }),
  })
  if (!response.ok) {
    throw new Error(`the park profile was refused: ${response.status} ${await response.text()}`)
  }
}

/** Run the live suite and report what it did. */
export async function runGatekeeperPhase(context: GatekeeperContext): Promise<GatekeeperReport> {
  const observations: Record<string, unknown> = {}
  const failures: string[] = []
  const reportPath = join(context.workDir, 'gatekeeper-live.json')

  try {
    await parkOnFirstStep(context)
  } catch (error) {
    return {
      observations,
      failures: [`the workspace could not be set to park: ${describe(error)}`],
    }
  }

  const run = await runVitest(context, reportPath)
  observations.suiteExitCode = run.exitCode

  const summary = await readReport(reportPath)
  if (summary === null) {
    // No report means the pool never got as far as running a spec (a missing binding, a workerd
    // that would not boot). The child's own output is the only thing that explains it, so it is
    // reported rather than summarised.
    failures.push(`the live suite produced no report. Its output was:\n${run.output}`)
    return { observations, failures }
  }

  observations.suiteSpecCount = summary.total
  observations.suiteCollectedSpecs = summary.total > 0
  observations.suiteFailures = summary.failed
  for (const failed of summary.failedNames) failures.push(`spec failed: ${failed}`)
  if (run.exitCode !== 0 && summary.failed === 0) {
    failures.push(`the live suite exited ${run.exitCode} with no failing spec`)
  }
  // The child's own output carries the diff, the stack and the deployment's refusal, and every one
  // of those is what a reader needs first. Printed once, and only when something went wrong.
  if (failures.length > 0) failures.push(`the live suite's output was:\n${run.output}`)

  return { observations, failures }
}

/** Grade the report against {@link GATEKEEPER_EXPECTED}. */
export function compareGatekeeperReport(report: GatekeeperReport): ParityProblem[] {
  const problems: ParityProblem[] = report.failures.map((failure) => ({
    kind: 'failure' as const,
    detail: `[gatekeeper] ${failure}`,
  }))
  for (const [key, expected] of Object.entries(GATEKEEPER_EXPECTED)) {
    const actual = report.observations[key]
    if (!sameValue(actual, expected)) {
      problems.push({
        kind: 'expectation',
        detail: `[gatekeeper] '${key}' is ${render(actual)}, expected ${render(expected)}`,
      })
    }
  }
  return problems
}

interface VitestRun {
  exitCode: number
  output: string
}

/**
 * Spawn the package's live suite.
 *
 * Its vitest is resolved through the PACKAGE's own dependency graph rather than this harness's, so
 * the pool plugin the config loads and the runner driving it are one installation. The deployment
 * is passed in the environment because that is what a Worker reads: the config turns these two into
 * bindings, and refuses to run without them.
 */
async function runVitest(context: GatekeeperContext, reportPath: string): Promise<VitestRun> {
  const child = spawn(
    process.execPath,
    [
      vitestBin(),
      'run',
      '--config',
      'vitest.live.config.ts',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${reportPath}`,
    ],
    {
      cwd: GATEKEEPER_PACKAGE,
      env: {
        ...process.env,
        CAT_FACTORY_BASE_URL: context.baseUrl,
        CAT_FACTORY_PROVISIONING_KEY: context.adminKey,
        // vitest colourises for a TTY it does not have here; the output is only ever read on
        // failure, where escape codes are noise.
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  const output: string[] = []
  child.stdout?.on('data', (chunk) => output.push(String(chunk)))
  child.stderr?.on('data', (chunk) => output.push(String(chunk)))

  const exitCode = await new Promise<number>((resolveExit) => {
    child.once('error', () => resolveExit(-1))
    child.once('exit', (code) => resolveExit(code ?? -1))
  })
  return { exitCode, output: output.join('') }
}

/** The vitest CLI the gatekeeper package installs, resolved through its own `node_modules`. */
function vitestBin(): string {
  const fromPackage = createRequire(join(GATEKEEPER_PACKAGE, 'package.json'))
  return join(dirname(fromPackage.resolve('vitest/package.json')), 'vitest.mjs')
}

interface Summary {
  total: number
  failed: number
  failedNames: string[]
}

/** Read vitest's JSON report, or `null` when the run never wrote one. */
async function readReport(path: string): Promise<Summary | null> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  await rm(path, { force: true })
  const parsed = JSON.parse(raw) as {
    numTotalTests?: number
    numFailedTests?: number
    testResults?: { assertionResults?: { status?: string; fullName?: string }[] }[]
  }
  const failedNames = (parsed.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
      .filter((assertion) => assertion.status === 'failed')
      .map((assertion) => assertion.fullName ?? 'an unnamed spec'),
  )
  return {
    total: parsed.numTotalTests ?? 0,
    failed: parsed.numFailedTests ?? failedNames.length,
    failedNames,
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
