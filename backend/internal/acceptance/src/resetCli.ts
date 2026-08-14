// `pnpm --filter @cat-factory/acceptance run reset [runId|latest] [--all] [--purge-repos] [--yes]`:
// clear a board back to "before any pass ran".
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
// It needs the BOARD half of the configuration and no more (`resolveBoardConfig`): an operator
// clearing a half-built pass is routinely doing so because the cluster or the reporter token it named
// has moved on, and refusing until the abandoned thing is configured again is a cleanup nobody can
// run.
//
// **The whole command is ONE function returning an exit code**, rather than a script punctuated by
// `process.exit`. That call tears the process down without draining a PIPED stdout, so
// `… run reset --all | tee plan.txt` lost the tail of the very plan the preview exists to be read.
// Setting `process.exitCode` and letting the process end on its own flushes what was written.
//
// **And every line goes to stdout, refusals included**, for the other half of that reason: `tee`
// captures one stream, so a refusal written to stderr is on the terminal and missing from the plan an
// operator kept, which is the file they are reading precisely because this command deletes things. The
// exit code carries the verdict; the stream carries the answer. Same rule in `runAcceptance.ts`.

import { rmSync } from 'node:fs'
import type { PrReportRunProvider } from '@cat-factory/sdk'
import { type BoardConfig, resolveBoardConfig, resolveReporterConfig } from './config.ts'
import { envFile } from './envFile.ts'
import { describeThrown, resetInvocation, scrubbed } from './operatorText.ts'
import {
  latestPointerPath,
  listPasses,
  packageRoot,
  readLatestPointer,
  resolveStateDir,
} from './passFiles.ts'
import {
  formatProviderPlan,
  formatProviderReport,
  planProviderPurge,
  type ProviderPurgeClients,
  type ProviderPurgePlan,
  providerPurgeSucceeded,
  runProviderPurge,
} from './providerPurge.ts'
import type { LedgerIssue } from './issuePurge.ts'
import { createClient } from './publicApi.ts'
import { REPO_CONTENT_APIS } from './repoContentApi.ts'
import { ISSUE_APIS, UNSUPPORTED_PROVIDER_REASON } from './vcsIssues.ts'
import {
  applyReset,
  formatResetPlan,
  formatResetReport,
  parseResetArgs,
  planReset,
  type ResetClient,
  type ResetPassOnDisk,
  type ResetPlan,
  resetSucceeded,
} from './reset.ts'
import { readWorld } from './world.ts'

process.exitCode = await run()

async function run(): Promise<number> {
  const parsed = parseResetArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.log(parsed.problem)
    return 2
  }

  // The same `.env` the pass itself runs from, with the shell winning over the file (`envFile.ts`
  // owns that rule). Read here rather than left to `process.env` because that file IS where an
  // operator's configuration lives: the pass reads it the same way (`envFile.ts`), and a cleanup that
  // only saw the shell would refuse a perfectly configured checkout with six missing variables.
  const env = { ...envFile(packageRoot), ...process.env }

  const resolution = resolveBoardConfig(env)
  if (!resolution.ok) {
    // Printed rather than thrown: a stack trace above the list is noise, and the list is the whole
    // message. Refused BEFORE anything is read, so a half-configured checkout deletes nothing.
    console.log(
      `The reset is not configured. It talks to a LIVE deployment and deletes real board state, so ` +
        `it refuses to guess.\n\n` +
        resolution.problems.map((problem) => `  - ${problem}`).join('\n') +
        `\n\nIt needs no cluster and no reporter token: those belong to RUNNING a pass. See ` +
        `backend/internal/acceptance/README.md.`,
    )
    return 2
  }
  const config = resolution.config
  // Off the resolved config rather than re-derived from the environment: `stateDir` is one of the
  // six variables `resolveBoardConfig` names, and the reason that table exists is that a pass and a
  // cleanup cannot come to disagree about which board they are pointed at.
  const stateDir = resolveStateDir(config.stateDir)
  const latest = readLatestPointer(stateDir)

  // `latest` resolves through the same pointer a resume follows, and an unresolvable one is a
  // REFUSAL rather than "clear whatever this configuration points at": the two are different
  // requests, and silently widening a named reset into an unnamed one is the shape that deletes
  // something nobody asked about.
  if (parsed.runId === 'latest' && latest?.runId == null) {
    console.log(
      `ACCEPTANCE_RUN_ID / the argument said 'latest', but ${latestPointerPath(stateDir)} names no ` +
        `pass that recorded a fact. Name a pass explicitly, or run the reset with no argument to ` +
        `clear what this configuration points at.`,
    )
    return 2
  }
  const namedRunId = parsed.runId === 'latest' ? (latest?.runId ?? null) : parsed.runId

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
    console.log(
      `No pass '${namedRunId}' in ${stateDir}. Run ` +
        `'pnpm --filter @cat-factory/acceptance run status' for the passes it holds, or drop the ` +
        `argument to clear what this configuration points at.`,
    )
    return 2
  }

  const sdk = createClient(config)

  // Resolved BEFORE anything is deleted, so a `--purge-repos` this deployment's provider cannot be
  // addressed with refuses having changed nothing, rather than clearing the board and then
  // discovering it cannot finish the job.
  const provider = parsed.purgeRepos ? await providerClients(env, sdk) : null
  if (provider !== null && !provider.ok) {
    console.log(provider.problem)
    return 2
  }
  const providerApis = provider?.ok === true ? provider.clients : null

  const client = resetClient(sdk)

  console.log(
    `reset against ${scrubbed(config.baseUrl)} (workspace ${config.workspaceId})\n` +
      `  repositories: ${config.repoOwner}/${config.repos.backend}, ` +
      `${config.repoOwner}/${config.repos.frontend}\n` +
      `  name prefix:  ${config.namePrefix}\n` +
      `  state dir:    ${stateDir}\n` +
      (namedRunId ? `  named pass:   ${namedRunId}\n` : '') +
      // Printed with the target rather than only in the plan, so the APPLY run's own output records
      // what it was pointed at: the preview is a separate invocation, and this line is the only thing
      // in a captured log that separates a whole-board clear from a configured one.
      (parsed.all ? `  scope:        --all (EVERY service frame this board lists)\n` : '') +
      (parsed.purgeRepos
        ? `  scope:        --purge-repos (also close this suite's issues and EMPTY both repositories)\n`
        : ''),
  )

  const plan = await planReset(client, {
    config,
    namedRunId,
    all: parsed.all,
    passes,
    latest,
    purgeProvider: parsed.purgeRepos,
  })

  const providerPlan =
    providerApis === null ? null : await planPurge(providerApis, config, plan, passes)

  if (!parsed.apply) {
    console.log(formatResetPlan(plan))
    if (providerPlan) console.log(formatProviderPlan(providerPlan))
    console.log(
      `\nNothing was changed. Run it again with --yes to carry this out:\n` +
        // Every argument this invocation carried, `--all` included: the printed command must delete
        // exactly the set just previewed, and dropping the flag would silently narrow it back.
        `  ${resetInvocation({
          ...(namedRunId ? { runId: namedRunId } : {}),
          ...(parsed.all ? { all: true } : {}),
          ...(parsed.purgeRepos ? { purgeRepos: true } : {}),
          apply: true,
        })}`,
    )
    return 0
  }

  return applyBoth(
    client,
    plan,
    providerApis !== null && providerPlan !== null
      ? { apis: providerApis, plan: providerPlan }
      : null,
  )
}

/**
 * What `--purge-repos` would do to the provider, from the plan the board half just made.
 *
 * Its own function because the two lists it derives are the same fact read from opposite sides, and
 * getting either wrong is silent: the passes this reset REMOVES name the issues that may be closed,
 * and the passes it KEEPS name the ones that may not, plus the consequence the purge has to state
 * about them.
 */
async function planPurge(
  apis: ProviderPurgeClients,
  config: BoardConfig,
  plan: ResetPlan,
  passes: readonly ResetPassOnDisk[],
): Promise<ProviderPurgePlan> {
  const removing = new Set(plan.passes.map((pass) => pass.runId))
  const kept = passes.filter((pass) => !removing.has(pass.runId))
  return planProviderPurge(apis, {
    targets: [
      { owner: config.repoOwner, repo: config.repos.backend },
      { owner: config.repoOwner, repo: config.repos.frontend },
    ],
    // Only the passes this reset is REMOVING: an issue belonging to a pass whose files are being
    // kept is one somebody may still resume, and closing it would settle a scenario 04 the resumed pass
    // is still waiting on.
    ledgerIssues: ledgerIssuesOf(passes, removing),
    // The same issues from the other side, because DISCOVERY cannot tell them apart: a kept pass's
    // issue carries this suite's title and this credential's authorship exactly as a removed pass's
    // does, so the exclusion has to be named rather than inferred.
    keptIssues: ledgerIssuesOf(passes, new Set(kept.map((pass) => pass.runId))),
    // Their files stay and their issues stay, but the repositories are shared by every pass on the
    // board: the purge states that consequence rather than leaving the retention to read as a
    // promise it does not keep.
    keptPasses: kept.map((pass) => pass.runId),
    stamp: backupStamp(),
  })
}

/**
 * Carry both halves out, and answer the exit code.
 *
 * The only part of this command that WRITES, which is why it is one function: the board goes first
 * and the provider second, and each REPORTS before the other is judged, so a captured log holds what
 * happened in the order it happened whichever half refused.
 *
 * They then close with different sentences, because they refuse over different things and need
 * different fixes. Sending an operator to "run the reset again" over a provider-only failure asks
 * them to re-clear a board that is already clear, which under `--purge-repos` empties both
 * repositories a second time.
 */
async function applyBoth(
  client: ResetClient,
  plan: ResetPlan,
  provider: { apis: ProviderPurgeClients; plan: ProviderPurgePlan } | null,
): Promise<number> {
  const report = await applyReset(client, { remove: removeFile }, plan)
  console.log(formatResetReport(report))
  let providerOk = true
  if (provider !== null) {
    const providerReport = await runProviderPurge(provider.apis, provider.plan)
    console.log(formatProviderReport(providerReport))
    providerOk = providerPurgeSucceeded(providerReport)
  }
  if (!resetSucceeded(report)) {
    console.log(
      `\nThe reset did not finish: something above refused, or a repository it cannot free is ` +
        `still held. The board still holds state a fresh pass will be refused over, so fix what is ` +
        `named and run the reset again.`,
    )
    return 1
  }
  if (!providerOk) {
    console.log(
      `\nThe board was cleared, but the PROVIDER half did not finish: something above refused. ` +
        `The board itself needs no second reset; fix what is named and run it again with ` +
        `--purge-repos to reclaim the rest.`,
    )
    return 1
  }
  console.log(
    `\nDone. A fresh pass can start: pnpm --filter @cat-factory/acceptance run acceptance`,
  )
  return 0
}

/**
 * The two provider clients `--purge-repos` needs, or the refusal naming what is missing.
 *
 * Extracted from `run` rather than inlined, because it is the one part of this command that resolves
 * a SECOND credential and it has four ways to refuse. Answering a discriminated result keeps the
 * caller a single branch, and keeps the refusal text beside the resolution that produced it.
 *
 * **Which provider is read off the WORKSPACE, never assumed.** The two tables answer null for a
 * provider this suite cannot address, and a caller that indexed them at `github` would turn that
 * seam into decoration: on a GitLab-connected workspace every call would go to `api.github.com`, the
 * 404s would read as "already closed or gone", and the command would exit 0 having done nothing. It
 * is the same read the `issue-credential` prerequisite makes, for the same reason.
 */
async function providerClients(
  env: Record<string, string | undefined>,
  sdk: ReturnType<typeof createClient>,
): Promise<{ ok: true; clients: ProviderPurgeClients } | { ok: false; problem: string }> {
  const reporter = resolveReporterConfig(env)
  if (!reporter.ok) {
    return {
      ok: false,
      problem:
        `--purge-repos is not configured.\n\n` +
        reporter.problems.map((problem) => `  - ${problem}`).join('\n') +
        `\n\nDrop the flag to clear the board only, which needs no provider credential.`,
    }
  }
  let provider: PrReportRunProvider | null
  try {
    provider = (await sdk.vcs.getConnection()).connection?.provider ?? null
  } catch (error) {
    return {
      ok: false,
      problem:
        `--purge-repos could not read which provider this workspace is connected to, so it does ` +
        `not know whose API to call and the board was left untouched: ${describeThrown(error)}`,
    }
  }
  if (provider === null) {
    return {
      ok: false,
      problem:
        `--purge-repos needs to know which provider this workspace is connected to, and it has no ` +
        `VCS connection at all. Connect it (Integrations, in the SPA), or drop the flag to clear ` +
        `the board only.`,
    }
  }
  const issues = ISSUE_APIS[provider]?.(reporter.reporter) ?? null
  const content = REPO_CONTENT_APIS[provider]?.(reporter.reporter) ?? null
  if (issues === null || content === null) {
    return {
      ok: false,
      problem:
        `--purge-repos cannot address '${provider}', which is what this workspace is connected ` +
        `to, so the board was left untouched. Drop the flag to clear the board only.\n\n` +
        UNSUPPORTED_PROVIDER_REASON[provider].map((reason) => `  - ${reason}`).join('\n'),
    }
  }
  return { ok: true, clients: { issues, content } }
}

/**
 * The issues recorded by a named set of passes, as the purge names them.
 *
 * Taken twice from opposite sides: the passes being REMOVED name what may be closed, and the passes
 * being KEPT name what may not, because somebody may still resume them and closing their issue would
 * settle the scenario-04 gate they are waiting on. One function for both, so the two lists cannot come to
 * disagree about what a ledger's issue is.
 */
function ledgerIssuesOf(
  passes: readonly ResetPassOnDisk[],
  runIds: ReadonlySet<string>,
): readonly LedgerIssue[] {
  return passes.flatMap((pass) => {
    const issue = pass.world?.intakeIssue
    if (!issue || !runIds.has(pass.runId)) return []
    return [
      {
        runId: pass.runId,
        target: { owner: issue.owner, repo: issue.repo },
        number: issue.number,
        url: issue.url,
      },
    ]
  })
}

/**
 * The namespace the backup tags of ONE invocation share.
 *
 * A wall-clock stamp rather than a run id: a purge is not a pass and routinely runs when no ledger is
 * left to take an id from. Its only job is to keep two purges of the same repository from colliding
 * on a tag name, which a second-resolution stamp does.
 */
function backupStamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/** The SDK, narrowed to the five calls the reset makes. */
function resetClient(sdk: ReturnType<typeof createClient>): ResetClient {
  return {
    repos: async () => (await sdk.repos.list()).repos,
    services: async () => (await sdk.services.list()).services,
    // Paged through rather than one bounded page: a frame with more tasks than the default page
    // would otherwise be deleted with the tail still under it, and the frame delete then refuses
    // over tasks the plan never listed, which reads as the reset having done nothing.
    //
    // Every task, `done` ones included, because the PLAN names what disappears and the frame delete
    // takes the whole subtree. Which of them needs a delete call of its own is `reset.ts`'s
    // decision, and it needs only the unfinished ones.
    tasks: async (serviceId) => {
      const tasks = []
      for await (const task of sdk.tasks.listByServiceAll(serviceId)) {
        tasks.push({ taskId: task.taskId, title: task.title, done: task.status === 'done' })
      }
      return tasks
    },
    deleteTask: (taskId) => sdk.tasks.delete(taskId),
    deleteService: (serviceId) => sdk.services.delete(serviceId),
  }
}

/**
 * Remove one file, answering whether this call removed one.
 *
 * `rmSync` without `force` is the whole check: it answers ENOENT for a file that is not there, so
 * the question is settled by the removal itself rather than by a separate existence read that a
 * concurrent removal can invalidate between the two. It is also why nothing here READS the file:
 * a long pass's journal is tens of megabytes, and loading one into a Buffer to ask whether it
 * exists is the cost of the answer paid several times over.
 *
 * Anything that is not "no such file" propagates: a file this command could not delete is a fact
 * about the cleanup, and reporting it as "there was nothing there" would leave a ledger behind
 * under a report saying it went.
 */
function removeFile(path: string): boolean {
  try {
    rmSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** A pass's ledger, or null when the file is absent, malformed, or belongs to a different pass. */
function ownWorld(ledgerPath: string, runId: string): ResetPassOnDisk['world'] {
  const world = readWorld(ledgerPath)
  return world && world.runId === runId ? world : null
}
