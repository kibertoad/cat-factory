// The cross-SDK smoketest entry point.
//
//   node --experimental-strip-types src/run.ts             (all four SDKs, then the MCP facade)
//   node --experimental-strip-types src/run.ts --only=go   (one, while iterating)
//   node --experimental-strip-types src/run.ts --only=mcp  (just the published MCP server)
//
// Boots a real Node backend (real Postgres, real pg-boss, fake agents), seeds a workspace, mints
// an `admin` and a `read` public-API key, then drives the SAME scenario through each SDK and
// compares the four observation reports. Then a second phase drives the published MCP server
// (`sdk/mcp`) as a real spawned process against the same backend; it is graded on absolute claims
// rather than compared, since there is only one implementation of it.
//
// Requires `DATABASE_URL`. A language whose toolchain is missing is SKIPPED LOUDLY — named in the
// summary and, in CI, treated as a failure — because a silent skip is indistinguishable from a
// pass, and "the Go SDK is fine" is exactly the wrong thing to conclude from "Go was not
// installed".

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedWorkspace, startBackend } from './backend.ts'
import { compareMcpReport, MCP_BIN, runMcpPhase } from './mcp.ts'
import { compareReports, type ParityProblem, type SdkReport } from './parity.ts'
import { RUNNERS, runSdk, toolchainAvailable } from './runners.ts'

const MCP_PHASE = 'mcp'

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
const port = Number(process.env.SDK_SMOKETEST_PORT ?? 8899)
// In CI every toolchain is installed on purpose, so a missing one is a broken workflow rather
// than a developer's laptop — and must fail rather than quietly shrink the matrix.
const requireAll = process.env.CI === 'true' || process.env.SDK_SMOKETEST_REQUIRE_ALL === 'true'

// `--only=mcp` names a phase rather than an SDK, so it filters the SDK list down to NOTHING and the
// MCP half carries the run on its own. Special-casing it into the "everything" branch instead would
// have `--only=mcp` compile Java to prove something about a Node binary.
const selected = only ? RUNNERS.filter((r) => r.name === only) : RUNNERS
const runMcp = !only || only === MCP_PHASE
if (selected.length === 0 && !runMcp) {
  console.error(
    `sdk-smoketest: no SDK named '${only}'. Known: ${[...RUNNERS.map((r) => r.name), MCP_PHASE].join(', ')}`,
  )
  process.exit(2)
}

const workDir = await mkdtemp(join(tmpdir(), 'cat-factory-sdk-smoketest-'))
const backend = await startBackend(port)
const reports: SdkReport[] = []
const skipped: string[] = []
const errored: string[] = []
const mcpProblems: ParityProblem[] = []
let mcpRan = false

try {
  console.log(`sdk-smoketest: backend up at ${backend.baseUrl}`)

  if (runMcp) {
    // BEFORE the four clients, so a missing build is reported in seconds rather than after the Java
    // compile. The artifact is ours rather than a language toolchain, so its absence is a failure
    // with a fix rather than a skip: nothing about this phase can be concluded without it.
    if (!existsSync(MCP_BIN)) {
      mcpProblems.push({
        kind: 'failure',
        detail:
          `[mcp] ${MCP_BIN} is not built. Run \`pnpm build\` (or ` +
          '`pnpm --filter @cat-factory/mcp-server build`) first.',
      })
    } else {
      const seeded = await seedWorkspace(backend.baseUrl, backend.controlPort)
      console.log(`sdk-smoketest: running the MCP facade against workspace ${seeded.workspaceId}`)
      const report = await runMcpPhase({
        baseUrl: backend.baseUrl,
        adminKey: seeded.adminKey,
        workDir,
      })
      mcpProblems.push(...compareMcpReport(report))
      mcpRan = true
    }
  }

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

// A heading with nothing under it reads as a section that passed. With `--only=mcp` no SDK was
// selected at all, so the cross-SDK half is not reported rather than reported empty.
const problems = reports.length >= 1 ? compareReports(reports) : []
if (selected.length > 0) {
  console.log('')
  console.log('=== cross-SDK parity ===')

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
}

if (runMcp) {
  console.log('')
  console.log('=== MCP facade (the published server, spawned) ===')
  for (const problem of mcpProblems) {
    console.error(`  ${problem.kind.toUpperCase()}: ${problem.detail}`)
  }
  if (mcpProblems.length === 0) {
    console.log('  the spawned server started, listed, called and refused as published.')
  }
}

const failed =
  problems.length > 0 ||
  mcpProblems.length > 0 ||
  errored.length > 0 ||
  (requireAll && skipped.length > 0) ||
  // A phase that reported nothing at all is not a pass. With `--only=mcp` the SDK reports are
  // legitimately empty, so each half vouches for itself rather than one count standing for both.
  (only === MCP_PHASE ? !mcpRan : reports.length === 0)
process.exit(failed ? 1 : 0)
