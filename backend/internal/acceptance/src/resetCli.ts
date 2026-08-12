// `pnpm --filter @cat-factory/acceptance run reset [runId|latest] [--yes]`: clear a board back to
// "before any pass ran".
//
// A sibling of `statusCli.ts` and `configureCli.ts` and thin for the same reason: every judgement
// lives in `reset.ts`, behind seams, so `test/reset.test.ts` drives the whole flow with no
// deployment and no filesystem. This file supplies the real ones and owns exactly two things a test
// has no opinion about: parsing the arguments, and the exit code.
//
// **Nothing is deleted without `--yes`.** The bare form is a PREVIEW, and that is the safety
// property: it prints every frame, task and file it would remove, on a board that may be shared with
// somebody else's pass. `pnpm` forwards both the positional and the flag straight through, so the
// advertised command needs no `--` separator.
//
// It needs the BOARD half of the configuration and no more (`requireBoardConfig`): an operator
// clearing a half-built pass is routinely doing so because the cluster or the reporter token it named
// has moved on, and refusing until the abandoned thing is configured again is a cleanup nobody can
// run.

import { readFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBoardConfig, stateDirFrom } from './config.ts'
import { envFile } from './envFile.ts'
import { resetInvocation } from './operatorText.ts'
import { latestPointerPath, listPasses, readLatestRunId, resolveStateDir } from './passFiles.ts'
import { createClient } from './publicApi.ts'
import {
  applyReset,
  formatResetPlan,
  formatResetReport,
  parseResetArgs,
  planReset,
  type ResetClient,
  type ResetPassOnDisk,
  resetSucceeded,
} from './reset.ts'
import { readWorld } from './world.ts'

const parsed = parseResetArgs(process.argv.slice(2))
if (!parsed.ok) {
  console.error(parsed.problem)
  process.exit(2)
}

// The same `.env` the pass itself runs from, with the shell winning over the file (`envFile.ts` owns
// that rule). Read here rather than left to `process.env` because that file IS where an operator's
// configuration lives: vitest loads it as `test.env` for the specs, and a cleanup that only saw the
// shell would refuse a perfectly configured checkout with six missing variables.
const env = { ...envFile(resolve(dirname(fileURLToPath(import.meta.url)), '..')), ...process.env }

const resolution = resolveBoardConfig(env)
if (!resolution.ok) {
  // Printed rather than thrown: a stack trace above the list is noise, and the list is the whole
  // message. Refused BEFORE anything is read, so a half-configured checkout deletes nothing.
  console.error(
    `The reset is not configured. It talks to a LIVE deployment and deletes real board state, so ` +
      `it refuses to guess.\n\n` +
      resolution.problems.map((problem) => `  - ${problem}`).join('\n') +
      `\n\nIt needs no cluster and no reporter token: those belong to RUNNING a pass. See ` +
      `backend/internal/acceptance/README.md.`,
  )
  process.exit(2)
}
const config = resolution.config
const stateDir = resolveStateDir(stateDirFrom(env))
const latestRunId = readLatestRunId(stateDir)

// `latest` resolves through the same pointer a resume follows, and an unresolvable one is a REFUSAL
// rather than "clear whatever this configuration points at": the two are different requests, and
// silently widening a named reset into an unnamed one is the shape that deletes something nobody
// asked about.
if (parsed.runId === 'latest' && latestRunId === null) {
  console.error(
    `ACCEPTANCE_RUN_ID / the argument said 'latest', but ${latestPointerPath(stateDir)} names no ` +
      `pass that recorded a fact. Name a pass explicitly, or run the reset with no argument to ` +
      `clear what this configuration points at.`,
  )
  process.exit(2)
}
const namedRunId = parsed.runId === 'latest' ? latestRunId : parsed.runId

const passes: readonly ResetPassOnDisk[] = listPasses(stateDir).map((pass) => ({
  runId: pass.runId,
  ledgerPath: pass.ledgerPath,
  journalPath: pass.journalPath,
  // A ledger whose stated id disagrees with its FILE NAME is read as naming nothing, exactly as
  // `findPassesNaming` does: a copied or renamed file is not evidence about which frames belong to
  // which pass, and deleting a frame on the strength of it would act on a guess.
  world: ownWorld(pass.ledgerPath, pass.runId),
}))

if (namedRunId !== null && !passes.some((pass) => pass.runId === namedRunId)) {
  // Stated rather than treated as an empty ledger: a typo'd run id would otherwise silently reset
  // only what the configuration points at, and report success for a pass it never read.
  console.error(
    `No pass '${namedRunId}' in ${stateDir}. Run ` +
      `'pnpm --filter @cat-factory/acceptance run status' for the passes it holds, or drop the ` +
      `argument to clear what this configuration points at.`,
  )
  process.exit(2)
}

const client = resetClient()

console.log(
  `reset against ${config.baseUrl} (workspace ${config.workspaceId})\n` +
    `  repositories: ${config.repoOwner}/${config.repos.backend}, ` +
    `${config.repoOwner}/${config.repos.frontend}\n` +
    `  name prefix:  ${config.namePrefix}\n` +
    `  state dir:    ${stateDir}\n` +
    (namedRunId ? `  named pass:   ${namedRunId}\n` : '') +
    // Printed with the target rather than only in the plan, so the APPLY run's own output records
    // what it was pointed at: the preview is a separate invocation, and this line is the only thing
    // in a captured log that separates a whole-board clear from a configured one.
    (parsed.all ? `  scope:        --all (EVERY service frame this board lists)\n` : ''),
)

const plan = await planReset(client, {
  config,
  namedRunId,
  all: parsed.all,
  passes,
  latest: { runId: latestRunId, path: latestPointerPath(stateDir) },
})

if (!parsed.apply) {
  console.log(formatResetPlan(plan))
  console.log(
    `\nNothing was changed. Run it again with --yes to carry this out:\n` +
      // Every argument this invocation carried, `--all` included: the printed command must delete
      // exactly the set just previewed, and dropping the flag would silently narrow it back.
      `  ${resetInvocation({
        ...(namedRunId ? { runId: namedRunId } : {}),
        ...(parsed.all ? { all: true } : {}),
        apply: true,
      })}`,
  )
  process.exit(0)
}

const report = await applyReset(client, { remove: removeFile }, plan)
console.log(formatResetReport(report))
if (!resetSucceeded(report)) {
  console.error(
    `\nThe reset did not finish: something above refused. The board still holds state a fresh ` +
      `pass will be refused over, so fix what is named and run the reset again.`,
  )
  process.exit(1)
}
console.log(`\nDone. A fresh pass can start: pnpm --filter @cat-factory/acceptance run acceptance`)

/** The SDK, narrowed to the five calls the reset makes. */
function resetClient(): ResetClient {
  const sdk = createClient(config)
  return {
    repos: async () => (await sdk.repos.list()).repos,
    services: async () => (await sdk.services.list()).services,
    // Paged through rather than one bounded page: a frame with more tasks than the default page
    // would otherwise be deleted with the tail still under it, and the frame delete then refuses
    // over tasks the plan never listed, which reads as the reset having done nothing.
    tasks: async (serviceId) => {
      const tasks = []
      for await (const task of sdk.tasks.listByServiceAll(serviceId)) {
        tasks.push({ taskId: task.taskId, title: task.title })
      }
      return tasks
    },
    deleteTask: (taskId) => sdk.tasks.delete(taskId),
    deleteService: (serviceId) => sdk.services.delete(serviceId),
  }
}

/** Remove one file, answering whether there was one. A missing file is the state being asked for. */
function removeFile(path: string): boolean {
  try {
    readFileSync(path)
  } catch {
    // silent-catch-ok: an absent file is the outcome this call wants, not a failure to report.
    return false
  }
  rmSync(path, { force: true })
  return true
}

/** A pass's ledger, or null when the file is absent, malformed, or belongs to a different pass. */
function ownWorld(ledgerPath: string, runId: string): ResetPassOnDisk['world'] {
  const world = readWorld(ledgerPath)
  return world && world.runId === runId ? world : null
}
