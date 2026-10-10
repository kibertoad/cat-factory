// Driving the Cloudflare OS GATEKEEPER against this deployment's real `/api/v1`.
//
// `@cat-factory/gatekeeper-worker` is a consumer of the public surface, and its own suite runs the
// assembled Worker in real workerd against a SCRIPTED cat-factory. That is what makes it hermetic,
// and it is also the one thing it cannot see: a fixture agrees with the package by construction, so
// a request shape the generated bindings and the SDK both consider correct fails for the first time
// against a real deployment. The generated table is regenerated from the same spec the deployment
// serves, which keeps the two from drifting on PATHS and SCOPES, never on what a body has to
// carry, which is where the first cut of that package's decision answerers were wrong.
//
// So this phase gives that suite a real origin. It seeds a workspace, points the Worker at this
// harness's own backend, and runs the package's `test/live` specs in workerd with no outbound
// service, so every call the Gatekeeper makes leaves the isolate and lands on the deployment.
//
// Three things follow from the shape of that, and all three are deliberate:
//
//   - THE SPECS ARE THE ASSERTIONS. Unlike the SDK phases, there is nothing to compare and no
//     report to grade field by field: the claims are in the specs, where the workerd runtime and
//     the Cap'n Web session they need already exist. What this module grades is that the suite RAN
//     and that everything in it passed, which is why the JSON reporter's per-assertion statuses are
//     read rather than the exit code or the totals: a suite that collected nothing exits 0, and so
//     does one whose specs were every one of them SKIPPED, which the totals still count as tests.
//   - THE DIAGNOSTIC IS THE CHILD'S OWN OUTPUT, and this phase is the only thing holding it. So
//     every way the run can go wrong lands as a FAILURE STRING carrying it, never as a thrown
//     error: `run.ts` calls this from a `try` whose `finally` only stops the backend, so a throw
//     escapes past the summary and takes the output with it.
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
  suiteExecutedSpecs: true,
  suiteFailures: 0,
  // A skip is not a pass either, and it is the one failure mode that survives every other check
  // here: a skipped spec exits 0, fails nothing, and is counted by the report's own total. This
  // suite has no conditional skips, so any at all means an assertion this lane claims to make is
  // not being made.
  suiteSkippedSpecs: 0,
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
  const reportPath = join(context.workDir, 'gatekeeper-live.json')

  try {
    await parkOnFirstStep(context)
  } catch (error) {
    return {
      observations: {},
      failures: [`the workspace could not be set to park: ${describe(error)}`],
    }
  }

  const run = await runVitest(context, reportPath)
  if (run.kind === 'unstartable') {
    // The CLI never ran, so there is no report to read and no output to quote: what a reader needs
    // is the reason it could not start, which is the one thing the child cannot have printed.
    return { observations: {}, failures: [`the live suite could not be started: ${run.detail}`] }
  }

  return gradeSuiteRun(run, await readReport(reportPath), reportPath)
}

/**
 * Turn one finished run into what the phase reports.
 *
 * Separated from the spawn and exported so the grading can be tested without a workerd pool: this
 * is where "the suite passed" is decided, and a bug in it is invisible by construction.
 */
export function gradeSuiteRun(
  run: { exitCode: number; output: string },
  report: ReportRead,
  reportPath: string,
): GatekeeperReport {
  const observations: Record<string, unknown> = { suiteExitCode: run.exitCode }
  const failures: string[] = []

  if (report.kind === 'absent') {
    // No report means the pool never got as far as running a spec (a missing binding, a workerd
    // that would not boot). The child's own output is the only thing that explains it, so it is
    // reported rather than summarised.
    return {
      observations,
      failures: [`the live suite produced no report. Its output was:\n${run.output}`],
    }
  }
  if (report.kind === 'unreadable') {
    // A DIFFERENT fact from the one above, and the reason both are named: a report that is present
    // but unparseable is a child killed mid-write, not a pool that never booted.
    return {
      observations,
      failures: [
        `the live suite's report at ${reportPath} is not readable JSON (${report.detail}). ` +
          `Its output was:\n${run.output}`,
      ],
    }
  }

  observations.suiteSpecCount = report.executed
  observations.suiteExecutedSpecs = report.executed > 0
  observations.suiteSkippedSpecs = report.skipped
  observations.suiteFailures = report.failed
  for (const failed of report.failedNames) failures.push(`spec failed: ${failed}`)
  // NAMED, not just counted: a skipped spec is an assertion this lane claims to make and did not,
  // and the count alone leaves a reader to work out which one from a suite they cannot see.
  for (const skipped of report.skippedNames) failures.push(`spec did not run: ${skipped}`)
  if (run.exitCode !== 0 && report.failed === 0) {
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

/**
 * What the child did.
 *
 * `unstartable` is its own outcome rather than an exit code, because the two need different
 * reports: a CLI that never started has no output to quote and a remedy to name instead, where a
 * CLI that ran and failed has output that IS the report.
 */
type VitestRun =
  | { kind: 'ran'; exitCode: number; output: string }
  | { kind: 'unstartable'; detail: string }

/**
 * Spawn the package's live suite.
 *
 * Its vitest is resolved through the PACKAGE's own dependency graph rather than this harness's, so
 * the pool plugin the config loads and the runner driving it are one installation. The deployment
 * is passed in the environment because that is what a Worker reads: the config turns these two into
 * bindings, and refuses to run without them.
 */
async function runVitest(context: GatekeeperContext, reportPath: string): Promise<VitestRun> {
  let bin: string
  try {
    bin = vitestBin()
  } catch (error) {
    // The same disposition `mcp.ts` gives its missing binary: an artifact of OURS that is absent is
    // a failure with a fix to name, and naming it here is what keeps it from escaping `run.ts` as a
    // resolution stack with no phase attached to it.
    return {
      kind: 'unstartable',
      detail:
        `vitest is not installed for ${GATEKEEPER_PACKAGE}. Run \`pnpm install\` first ` +
        `(${describe(error)}).`,
    }
  }

  const child = spawn(
    process.execPath,
    [
      bin,
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

  // Collected rather than settled on, so that ONE listener ends the wait: an array because the
  // handler assigns from a closure, where narrowing a `let` back to its declared type is a
  // reader's guess about the compiler rather than something the code says.
  const spawnFailures: unknown[] = []
  child.once('error', (error) => spawnFailures.push(error))

  // `close`, never `exit`: `exit` fires when the process ends, which is BEFORE its piped stdout and
  // stderr have necessarily been drained, and that output is the only diagnostic this phase has.
  // A child that never spawned emits `error` and then `close` too, so this settles that case as
  // well rather than hanging on it.
  const exitCode = await new Promise<number | null>((settle) => {
    child.once('close', (code) => settle(code))
  })

  if (spawnFailures.length > 0) {
    return { kind: 'unstartable', detail: `${bin} could not be run: ${describe(spawnFailures[0])}` }
  }
  // A `null` code is a child killed by a signal, which is a run that happened and whose output is
  // worth quoting, so it stays an exit code rather than becoming `unstartable`.
  return { kind: 'ran', exitCode: exitCode ?? -1, output: output.join('') }
}

/** The vitest CLI the gatekeeper package installs, resolved through its own `node_modules`. */
function vitestBin(): string {
  const fromPackage = createRequire(join(GATEKEEPER_PACKAGE, 'package.json'))
  return join(dirname(fromPackage.resolve('vitest/package.json')), 'vitest.mjs')
}

export interface Summary {
  kind: 'read'
  /** Specs that actually ran. NOT the report's own total, which counts the skipped ones. */
  executed: number
  skipped: number
  skippedNames: string[]
  failed: number
  failedNames: string[]
}

/**
 * What reading vitest's JSON report found.
 *
 * `absent` and `unreadable` are separate outcomes because they are separate facts with separate
 * fixes: nothing was written at all, versus something was written and is not a report.
 */
export type ReportRead = Summary | { kind: 'absent' } | { kind: 'unreadable'; detail: string }

/**
 * Reduce vitest's JSON report to what this phase grades.
 *
 * Split from the file read and exported so it can be tested on its own: it is the one piece of
 * this module whose bug is SILENT, reporting a pass for a run that asserted nothing.
 */
export function summariseVitestReport(raw: string): ReportRead {
  let parsed: { testResults?: { assertionResults?: { status?: string; fullName?: string }[] }[] }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch (error) {
    // Never thrown: a child killed mid-write is exactly when the phase's report matters most, and a
    // parse error escaping this module takes the child's output out with it.
    return { kind: 'unreadable', detail: describe(error) }
  }

  // Counted off the individual ASSERTIONS rather than the report's `numTotalTests`, which counts a
  // skipped spec as a test: read that way, an all-skipped suite satisfies every expectation here
  // while having asserted nothing. Anything that is not passed or failed did not execute, whichever
  // of vitest's several spellings for that the reporter used.
  const assertions = (parsed.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
  const nameOf = (assertion: { fullName?: string }): string =>
    assertion.fullName ?? 'an unnamed spec'
  const executed = assertions.filter(
    (assertion) => assertion.status === 'passed' || assertion.status === 'failed',
  )
  const failedNames = assertions
    .filter((assertion) => assertion.status === 'failed')
    .map((assertion) => nameOf(assertion))
  const skippedNames = assertions
    .filter((assertion) => assertion.status !== 'passed' && assertion.status !== 'failed')
    .map((assertion) => nameOf(assertion))

  return {
    kind: 'read',
    executed: executed.length,
    skipped: skippedNames.length,
    skippedNames,
    failed: failedNames.length,
    failedNames,
  }
}

/** Read vitest's JSON report. */
async function readReport(path: string): Promise<ReportRead> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { kind: 'absent' }
  }
  await rm(path, { force: true })
  return summariseVitestReport(raw)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
