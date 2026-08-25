// The cross-SDK smoketest entry point.
//
//   node --experimental-strip-types src/run.ts                     (four SDKs, then both MCP paths)
//   node --experimental-strip-types src/run.ts --only=go           (one SDK, while iterating)
//   node --experimental-strip-types src/run.ts --only=mcp          (just the published MCP server)
//   node --experimental-strip-types src/run.ts --only=mcp-hosted   (just the hosted MCP endpoint)
//   node --experimental-strip-types src/run.ts --only=gatekeeper   (the Gatekeeper Worker, in workerd)
//
// Boots a real Node backend (real Postgres, real pg-boss, fake agents), seeds a workspace, mints
// an `admin` and a `read` public-API key, then drives the SAME scenario through each SDK and
// compares the four observation reports. Then two MCP phases against the same backend: the
// published server (`sdk/mcp`) as a real spawned process, and the deployment's own hosted endpoint
// (`POST /api/v1/mcp`) through a real Streamable HTTP client. Both are graded on absolute claims
// rather than compared, since there is one implementation of each — but they run against one
// deployment on purpose, so the two access paths answering differently shows up as one phase's
// observations moving while the other's do not.
//
// Requires `DATABASE_URL`. A language whose toolchain is missing is SKIPPED LOUDLY — named in the
// summary and, in CI, treated as a failure — because a silent skip is indistinguishable from a
// pass, and "the Go SDK is fine" is exactly the wrong thing to conclude from "Go was not
// installed".
//
// The GATEKEEPER phase is the one that is not in the "everything" run, and the summary says so
// rather than leaving it to be inferred. It boots a second runtime (workerd, through the Gatekeeper
// package's own pool) and drives a real run to a real park, so it is both the slowest phase and the
// only one whose subject is a CONSUMER of the surface rather than the surface itself. CI runs it in
// the Gatekeeper's own non-blocking lane, where a partner-side protocol still in motion cannot turn
// this repo's required checks red; `--only=gatekeeper` is how that lane asks for it.

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reserveDeadUrl, seedWorkspace, startBackend } from './backend.ts'
import { compareGatekeeperReport, runGatekeeperPhase } from './gatekeeper.ts'
import { compareMcpReport, MCP_BIN, runMcpPhase } from './mcp.ts'
import { compareHostedMcpReport, runHostedMcpPhase } from './mcpHosted.ts'
import { compareReports, type ParityProblem, type SdkReport } from './parity.ts'
import { RUNNERS, runSdk, toolchainAvailable } from './runners.ts'

const MCP_PHASE = 'mcp'
const HOSTED_PHASE = 'mcp-hosted'
const GATEKEEPER_PHASE = 'gatekeeper'

const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
const port = Number(process.env.SDK_SMOKETEST_PORT ?? 8899)
// In CI every toolchain is installed on purpose, so a missing one is a broken workflow rather
// than a developer's laptop — and must fail rather than quietly shrink the matrix.
const requireAll = process.env.CI === 'true' || process.env.SDK_SMOKETEST_REQUIRE_ALL === 'true'

// The MCP names are PHASES rather than SDKs, so each filters the SDK list down to NOTHING and carries
// the run on its own. Special-casing them into the "everything" branch instead would have
// `--only=mcp` compile Java to prove something about a Node binary.
const selected = only ? RUNNERS.filter((r) => r.name === only) : RUNNERS
const runMcp = !only || only === MCP_PHASE
const runHosted = !only || only === HOSTED_PHASE
// ASKED FOR BY NAME, never part of the everything run: see the header. It is reported as not run
// rather than omitted, because a section that is simply absent reads as a section that passed.
const runGatekeeper = only === GATEKEEPER_PHASE
if (selected.length === 0 && !runMcp && !runHosted && !runGatekeeper) {
  console.error(
    `sdk-smoketest: no SDK named '${only}'. Known: ${[...RUNNERS.map((r) => r.name), MCP_PHASE, HOSTED_PHASE, GATEKEEPER_PHASE].join(', ')}`,
  )
  process.exit(2)
}

const workDir = await mkdtemp(join(tmpdir(), 'cat-factory-sdk-smoketest-'))
const backend = await startBackend(port)
// Reserved ONCE, so the four clients diagnose the same unlistened port rather than four of them.
const deadUrl = await reserveDeadUrl()
const reports: SdkReport[] = []
const skipped: string[] = []
const errored: string[] = []
const mcpProblems: ParityProblem[] = []
const hostedProblems: ParityProblem[] = []
const gatekeeperProblems: ParityProblem[] = []
let mcpRan = false
let hostedRan = false
let gatekeeperRan = false
let gatekeeperSpecs = 0

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

  if (runHosted) {
    // BEFORE the four clients for the same reason as the phase above: it needs no language toolchain,
    // so a failure here is reported in seconds rather than after the Java compile. A FRESH workspace,
    // so its assertions never depend on what the spawned server left behind.
    const seeded = await seedWorkspace(backend.baseUrl, backend.controlPort)
    console.log(
      `sdk-smoketest: driving the hosted MCP endpoint against workspace ${seeded.workspaceId}`,
    )
    hostedProblems.push(
      ...compareHostedMcpReport(
        await runHostedMcpPhase({
          baseUrl: backend.baseUrl,
          adminKey: seeded.adminKey,
          readKey: seeded.readKey,
        }),
      ),
    )
    hostedRan = true
  }

  if (runGatekeeper) {
    // A FRESH workspace, like every other phase, and with one difference of its own: it is asked to
    // park its runs on the first agent step, which is the case the Gatekeeper exists for.
    const seeded = await seedWorkspace(backend.baseUrl, backend.controlPort)
    console.log(
      `sdk-smoketest: driving the Gatekeeper Worker against workspace ${seeded.workspaceId}`,
    )
    const report = await runGatekeeperPhase({
      baseUrl: backend.baseUrl,
      controlPort: backend.controlPort,
      workspaceId: seeded.workspaceId,
      adminKey: seeded.adminKey,
      workDir,
    })
    gatekeeperProblems.push(...compareGatekeeperReport(report))
    gatekeeperSpecs = Number(report.observations.suiteSpecCount ?? 0)
    gatekeeperRan = true
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
          deadUrl,
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

if (runHosted) {
  console.log('')
  console.log('=== MCP facade (the hosted endpoint, over HTTP) ===')
  for (const problem of hostedProblems) {
    console.error(`  ${problem.kind.toUpperCase()}: ${problem.detail}`)
  }
  if (hostedProblems.length === 0) {
    console.log(
      '  the hosted endpoint negotiated, listed, called, wrote and refused as documented.',
    )
  }
}

console.log('')
console.log('=== Cloudflare OS Gatekeeper (the Worker, in workerd) ===')
if (runGatekeeper) {
  for (const problem of gatekeeperProblems) {
    console.error(`  ${problem.kind.toUpperCase()}: ${problem.detail}`)
  }
  if (gatekeeperProblems.length === 0) {
    console.log(
      `  ${gatekeeperSpecs} spec(s): the Gatekeeper enrolled, minted, forwarded and answered a ` +
        'real park.',
    )
  }
} else {
  // Stated rather than omitted: a heading with nothing under it reads as a section that passed, and
  // this is the one phase the everything run leaves out.
  console.log('  NOT RUN. It is asked for by name: `--only=gatekeeper` (its own CI lane does).')
}

const failed =
  problems.length > 0 ||
  mcpProblems.length > 0 ||
  hostedProblems.length > 0 ||
  gatekeeperProblems.length > 0 ||
  errored.length > 0 ||
  (requireAll && skipped.length > 0) ||
  // A phase that reported nothing at all is not a pass. With `--only=<phase>` the SDK reports are
  // legitimately empty, so each phase vouches for itself rather than one count standing for all.
  (only === MCP_PHASE
    ? !mcpRan
    : only === HOSTED_PHASE
      ? !hostedRan
      : only === GATEKEEPER_PHASE
        ? !gatekeeperRan
        : reports.length === 0)
process.exit(failed ? 1 : 0)
