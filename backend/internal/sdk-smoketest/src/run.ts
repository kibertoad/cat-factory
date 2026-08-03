// The cross-SDK smoketest entry point.
//
//   node --experimental-strip-types src/run.ts            (all four SDKs)
//   node --experimental-strip-types src/run.ts --only=go   (one, while iterating)
//
// Boots a real Node backend (real Postgres, real pg-boss, fake agents), seeds a workspace, mints
// an `admin` and a `read` public-API key, then drives the SAME scenario through each SDK and
// compares the four observation reports.
//
// Requires `DATABASE_URL`. A language whose toolchain is missing is SKIPPED LOUDLY — named in the
// summary and, in CI, treated as a failure — because a silent skip is indistinguishable from a
// pass, and "the Go SDK is fine" is exactly the wrong thing to conclude from "Go was not
// installed".

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspace, startBackend } from './backend.ts'
import { compareReports, type SdkReport } from './parity.ts'
import { RUNNERS, runSdk, toolchainAvailable } from './runners.ts'

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
const port = Number(process.env.SDK_SMOKETEST_PORT ?? 8899)
// In CI every toolchain is installed on purpose, so a missing one is a broken workflow rather
// than a developer's laptop — and must fail rather than quietly shrink the matrix.
const requireAll = process.env.CI === 'true' || process.env.SDK_SMOKETEST_REQUIRE_ALL === 'true'

const selected = only ? RUNNERS.filter((runner) => runner.name === only) : RUNNERS
if (selected.length === 0) {
  console.error(
    `sdk-smoketest: no SDK named '${only}'. Known: ${RUNNERS.map((r) => r.name).join(', ')}`,
  )
  process.exit(2)
}

const workDir = await mkdtemp(join(tmpdir(), 'cat-factory-sdk-smoketest-'))
const backend = await startBackend(port)
const reports: SdkReport[] = []
const skipped: string[] = []
const errored: string[] = []

try {
  console.log(`sdk-smoketest: backend up at ${backend.baseUrl}`)

  for (const runner of selected) {
    if (!(await toolchainAvailable(runner))) {
      skipped.push(runner.name)
      console.warn(`sdk-smoketest: SKIPPING ${runner.name} — its toolchain is not installed`)
      continue
    }

    // A FRESH workspace per SDK. Sharing one would make each SDK's observations depend on what
    // the SDKs before it left behind — the task list would grow under them, and a genuine
    // pagination bug would be indistinguishable from "the previous SDK created a task".
    const seeded = await seedWorkspace(backend.baseUrl, backend.controlPort)
    console.log(`sdk-smoketest: running ${runner.name} against workspace ${seeded.workspaceId}`)

    try {
      reports.push(
        await runSdk(runner, {
          baseUrl: backend.baseUrl,
          adminKey: seeded.adminKey,
          readKey: seeded.readKey,
          outPath: join(workDir, `${runner.name}.json`),
        }),
      )
    } catch (error) {
      // Keep going: one SDK failing outright is exactly when the other three's reports are most
      // useful, because they show whether the fault is in that client or in the deployment.
      errored.push(runner.name)
      console.error(
        `sdk-smoketest: ${runner.name} FAILED — ${error instanceof Error ? error.message : error}`,
      )
    }
  }
} finally {
  await backend.stop()
  await rm(workDir, { recursive: true, force: true })
}

console.log('')
console.log('=== cross-SDK parity ===')

const problems = reports.length >= 1 ? compareReports(reports) : []
for (const problem of problems) {
  console.error(`  ${problem.kind.toUpperCase()}: ${problem.detail}`)
}
if (problems.length === 0 && reports.length > 0) {
  const keyCount = Object.keys(reports[0]?.observations ?? {}).length
  console.log(`  ${reports.length} SDK(s) agreed on all ${keyCount} observations.`)
}

if (skipped.length > 0) {
  const line = `  SKIPPED (toolchain absent): ${skipped.join(', ')}`
  if (requireAll) console.error(line)
  else console.warn(line)
}
if (errored.length > 0) {
  console.error(`  ERRORED: ${errored.join(', ')}`)
}

// A comparison across ONE report is not a parity check. Say so rather than reporting the
// vacuous pass that "0 disagreements" would otherwise look like.
if (reports.length < 2 && !only) {
  console.error('  NOTE: fewer than two SDKs reported, so nothing was actually compared.')
}

const failed =
  problems.length > 0 ||
  errored.length > 0 ||
  (requireAll && skipped.length > 0) ||
  reports.length === 0
process.exit(failed ? 1 : 0)
