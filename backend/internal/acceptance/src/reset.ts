// RESETTING a board back to "before any pass ran", so the next attempt starts clean.
//
// The refusal this exists for is `target-repos` (and its sibling `board-titles`): a repository that
// already backs a service frame some earlier pass created is refused, because a fresh pass would
// adopt work that is not its own. The remedy has always offered two ways out, RESUME the pass that
// owns it or point the suite at fresh repositories, and a third that was not a command at all:
// "delete the service frame that holds this one". Deleting a frame was an app act, so the one
// instruction an operator running a HEADLESS pass could not carry out headlessly was the one that
// starts over. `DELETE /api/v1/services/{serviceId}` closed that (see `backend/docs/public-api.md`),
// and this is the command that uses it.
//
// Three rules shape it, and each is a decision rather than a style:
//
//   1. **It plans before it touches anything, and the plan is the default output.** This deletes
//      real services, real tasks and real run history on a board that may be shared, so the
//      dangerous half is opt-in (`--yes`). A reset nobody can preview is a reset nobody should run.
//   2. **The TARGET is what this configuration would adopt, not what a ledger remembers.** The gate
//      refuses over the board as it stands, so a reset that could only clear what a ledger names
//      would be unable to clear the state whose owning ledger is gone: another machine, another
//      operator, a state directory someone deleted. Which is exactly the case with no other way out.
//   3. **What it cannot reclaim is STATED.** A reset that silently leaves two scaffolded
//      repositories, an open issue and a cluster namespace behind reads as "the board is clean",
//      and the next pass then scaffolds on top of a tree that is already built.
//
// `--all` is a fourth target beside those two, not a wider reading of them: EVERY frame the board
// lists, whatever backs it and whatever it is called. It exists because the two questions above are
// deliberately narrow (they answer the two refusals a pass earns), and a board accumulates frames
// they cannot see: a pass run under a different `ACCEPTANCE_NAME_PREFIX`, one whose repositories the
// `.env` has since replaced, a frame raised by hand while debugging. None of those blocks the next
// pass, so clearing them is housekeeping rather than a remedy, which is why no refusal prints the
// flag. What makes it safe is what makes the default safe: the plan names every frame it would
// delete and `--yes` is still the whole of the opt-in, so a whole-board clear takes two deliberate
// arguments and one reading in between.
//
// The local files come LAST and only for a pass whose frames all went: a ledger removed while its
// frame survives strands that frame with no pass to name, which is the state `findPassesNaming`
// exists to keep out of the refusals. A repository this reset could not FREE counts the same way,
// because the frame still holding it is one no read here can name at all (`keepReason`).

import { CatFactoryNotFoundError, CatFactoryValidationError } from '@cat-factory/sdk'
import { blockedRepoMessage, sameRepo } from './adopt.ts'
import type { BoardConfig } from './config.ts'
import { serviceTitles } from './instructions.ts'
import { describeThrown, resetInvocation } from './operatorText.ts'
import type { LatestPointer } from './passFiles.ts'
import type { World } from './world.ts'

/**
 * The command line, or the refusal naming what was passed.
 *
 * Here rather than in `resetCli.ts` because a CLI module is a SCRIPT: importing one to test its
 * parser runs the whole command, deployment reads and `process.exit` included.
 *
 * A positional that looks like a flag is REFUSED rather than taken as a run id. `status` reads
 * `argv[2]` as one, so a mistyped `--dry-run` there reports on a pass called `--dry-run` and answers
 * "no such pass", which reads as a broken state directory; here the same slip is worse, because the
 * flag being reached for is the one that decides whether anything is deleted.
 */
export function parseResetArgs(
  argv: readonly string[],
):
  | { ok: true; runId: string | null; all: boolean; apply: boolean; purgeRepos: boolean }
  | { ok: false; problem: string } {
  let runId: string | null = null
  let apply = false
  let all = false
  let purgeRepos = false
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      apply = true
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    // Its own flag rather than part of `--all`, which is about how much of the BOARD to clear. This
    // is a different axis (the provider side), it needs a credential the board half does not, and
    // bundling the two would make a whole-board clear silently start rewriting repositories.
    if (arg === '--purge-repos') {
      purgeRepos = true
      continue
    }
    if (arg.startsWith('-')) {
      return {
        ok: false,
        problem:
          `unknown option '${arg}'. Usage: ${resetInvocation()} ` +
          `[runId|latest] [--all] [--purge-repos] [--yes]`,
      }
    }
    if (runId !== null) {
      return {
        ok: false,
        problem:
          `'${runId}' and '${arg}' both name a pass, and a reset clears ONE named pass plus ` +
          `whatever this configuration points at. Run it once per pass.`,
      }
    }
    runId = arg
  }
  return { ok: true, runId, all, apply, purgeRepos }
}

/** One row of `GET /api/v1/repos`, narrowed to what decides whether a repository is spoken for. */
export type ResetRepoRow = {
  owner: string
  name: string
  serviceId: string | null
  linkedElsewhere: boolean
}

/** One service frame, as `GET /api/v1/services` reports it. */
export type ResetServiceRow = { serviceId: string; title: string }

/** One task under a frame, as `GET /api/v1/services/:serviceId/tasks` reports it. */
export type ResetTaskRow = {
  taskId: string
  title: string
  /**
   * Whether the platform counts it as FINISHED, i.e. whether the frame delete's guard sees it.
   *
   * Carried rather than derived from the status vocabulary at the call site, because it decides
   * which tasks are deleted one by one: `removeBlock` cascades the whole subtree, so the only
   * tasks that need a call of their own are the unfinished ones the guard would refuse over. A
   * finished pass leaves dozens of `done` tasks per frame, and each individual delete is a
   * whole-board read on the deployment for work the frame delete does anyway.
   */
  done: boolean
}

/**
 * What this command needs from the deployment, narrowed to the five calls it makes.
 *
 * A port rather than the SDK client for the same reason `configure` has one: the whole flow is then
 * drivable with no deployment, and a test can assert the ORDER of the writes, which is the property
 * that matters most here (tasks before their frame) and the one an integration test would be the
 * most expensive way to check.
 */
export type ResetClient = {
  repos(): Promise<readonly ResetRepoRow[]>
  services(): Promise<readonly ResetServiceRow[]>
  /** Every task under a frame, across pages. */
  tasks(serviceId: string): Promise<readonly ResetTaskRow[]>
  deleteTask(taskId: string): Promise<void>
  deleteService(serviceId: string): Promise<void>
}

/** One pass on disk, as the caller read it through `passFiles.ts` (the one owner of the layout). */
export type ResetPassOnDisk = {
  runId: string
  ledgerPath: string
  journalPath: string
  /** Its ledger, or null when the file is absent or malformed (a refused attempt has none). */
  world: World | null
}

export type ResetInput = {
  config: BoardConfig
  /**
   * The pass named on the command line, or null.
   *
   * Its own input rather than something derived from the state directory, because naming one WIDENS
   * the target: a pass whose ledger holds frames this configuration no longer points at (the `.env`
   * moved on, the prefix changed) is otherwise unreachable, and clearing it is precisely what
   * someone naming it is asking for.
   */
  namedRunId: string | null
  /**
   * `--all`: target every frame the board lists, rather than the two questions this configuration
   * asks.
   *
   * Its own field rather than a mode threaded through the two questions, because it does not widen
   * either of them: they ask what would be REFUSED, and this asks what is THERE. Keeping them
   * separate is what lets a frame in the plan for both reasons still state both.
   */
  all: boolean
  passes: readonly ResetPassOnDisk[]
  /**
   * The `latest` pointer file, or null when there is none.
   *
   * The FILE rather than what it resolves to, because a pointer naming nothing is a state a
   * cleanup has to act on: see {@link LatestPointer}.
   */
  latest: LatestPointer | null
  /**
   * Whether `--purge-repos` is reclaiming the PROVIDER side in the same invocation.
   *
   * Needed by a plan that makes no provider call, because {@link leftoversOf} states in writing that
   * the two repositories keep their content and that a reporter's issue stays open. Those sentences
   * are the whole reason a cleared board is not read as a fresh one, and the purge makes both false.
   * A leftovers paragraph that is wrong is worse than none: it is the part of this output an operator
   * takes on trust precisely because they cannot see the repositories from here.
   */
  purgeProvider?: boolean
}

/** Why a frame is in the plan. Several can be true of one frame, and all of them are stated. */
export type FrameReason =
  | { kind: 'backs-repo'; slug: string }
  | { kind: 'holds-title'; title: string }
  | { kind: 'named-by-pass'; runId: string }
  | { kind: 'whole-board' }

export type PlannedFrame = {
  serviceId: string
  /** As the board reports it, or null for a frame only a ledger names (already gone, or archived). */
  title: string | null
  reasons: readonly FrameReason[]
  tasks: readonly ResetTaskRow[]
  /** True when `GET /api/v1/services` does not list it, so there is nothing here to delete. */
  absent: boolean
}

/** A repository the reset cannot free, with the steps `adopt.ts` owns for it. */
export type StuckRepo = { slug: string; steps: readonly string[] }

export type PlannedPass = {
  runId: string
  /** The files that would go. */
  paths: readonly string[]
  /** The frames its ledger names, so the apply can keep its files when one survives. */
  serviceIds: readonly string[]
  /**
   * The frames its ledger names that the board still LISTS and this plan does not target.
   *
   * The state that made this field necessary: a pass holding two services, only one of which this
   * configuration still points at (the `.env` moved to a new repository, the prefix changed). The
   * plan takes the one, and removing the ledger would strand the other with nothing naming its
   * owner, which is the exact dead end `findPassesNaming` exists to keep out of the refusals: the
   * frame earns `target-repos` again and the run id that would have resumed it was in the file just
   * deleted. Empty by construction for a pass named on the command line, since naming one adds
   * everything its ledger holds to the plan.
   */
  unreclaimed: readonly string[]
  /**
   * The issue its ledger records, if any.
   *
   * Carried on the pass rather than looked up again at report time, because deleting the ledger is
   * what makes it unrecoverable: this is the last moment anything knows the URL.
   */
  issueUrl: string | null
}

export type ResetPlan = {
  /**
   * Which question built the frame list: this configuration's two, or `--all`.
   *
   * Carried on the plan rather than left to the caller that passed the flag, because the PREVIEW is
   * what an operator grades a whole-board clear on, and "every frame on this board" and "the frames
   * this `.env` points at" are the same list on a board holding only one pass. A preview that cannot
   * tell those apart reads as the narrow one, which is the reading that makes the `--yes` a surprise.
   */
  scope: 'configured' | 'whole-board'
  frames: readonly PlannedFrame[]
  stuck: readonly StuckRepo[]
  /**
   * Configured repositories this workspace has not LINKED, so no row here says what backs them.
   *
   * Reported rather than passed over, because "nothing on this board backs it" and "this read cannot
   * see it" are different facts and only the first one means a reset has nothing to do. A repository
   * homed on another board of the account and not linked here reads identically to a fresh one from
   * `GET /api/v1/repos`; `target-repos` is what tells those apart, by point-reading
   * `/repos/available`, and it refuses with the steps. Saying so keeps a plan that clears nothing from
   * reading as a board that is already clean.
   */
  unlinked: readonly string[]
  passes: readonly PlannedPass[]
  /**
   * The `latest` pointer, when this reset would remove it: it names a pass in this plan, or the
   * scope is `--all` (which clears the state directory, so a pointer naming a pass that is no
   * longer there goes with it). `runId` is null for a pointer that names nothing readable.
   */
  pointer: { runId: string | null; path: string } | null
  /** What a reset does NOT reclaim, one sentence each. Never empty. */
  leftovers: readonly string[]
}

/**
 * What a reset WOULD do, from three reads and the state directory.
 *
 * The frames come from two independent questions, unioned, because the two refusals a reset answers
 * ask different ones: `target-repos` is about a REPOSITORY that is spoken for, and `board-titles` is
 * about a TITLE that is taken. A frame can be in the plan for either reason (a service whose
 * repository was re-pointed keeps the title; a frame renamed by hand keeps the repository), and a
 * plan built from one question alone leaves the other refusal firing after a reset reported success.
 */
export async function planReset(client: ResetClient, input: ResetInput): Promise<ResetPlan> {
  const { config } = input
  const latestRunId = input.latest?.runId ?? null
  const [repos, services] = await Promise.all([client.repos(), client.services()])
  const byId = new Map(services.map((service) => [service.serviceId, service]))

  const reasons = new Map<string, FrameReason[]>()
  const add = (serviceId: string, reason: FrameReason): void => {
    const existing = reasons.get(serviceId)
    if (existing) existing.push(reason)
    else reasons.set(serviceId, [reason])
  }

  // The repositories this configuration adopts, and whatever backs each one today.
  const stuck: StuckRepo[] = []
  const unlinked: string[] = []
  for (const name of [config.repos.backend, config.repos.frontend]) {
    const row = repos.find((repo) => sameRepo(repo, config.repoOwner, name))
    if (!row) {
      unlinked.push(`${config.repoOwner}/${name}`)
      continue
    }
    const slug = `${row.owner}/${row.name}`
    if (row.serviceId) {
      add(row.serviceId, { kind: 'backs-repo', slug })
      continue
    }
    // `serviceId: null` WITH `linkedElsewhere` is a frame homed on another board, which has no id
    // this workspace-scoped key could delete. Stated rather than skipped: it is the one blocker a
    // reset cannot clear, and reading it as "nothing to do" is what would send an operator back
    // round the same refusal wondering why the reset changed nothing.
    if (row.linkedElsewhere) {
      stuck.push({ slug, steps: blockedRepoMessage(slug, 'linked-elsewhere') })
    }
  }

  for (const title of Object.values(serviceTitles(config.namePrefix))) {
    for (const service of services.filter((entry) => entry.title === title)) {
      add(service.serviceId, { kind: 'holds-title', title })
    }
  }

  // A NAMED pass widens the target to whatever its own ledger holds. No LEDGER does anything else:
  // the frames of a pass nobody named are already covered by the two questions above, and reaching
  // into every ledger on disk would clear a colleague's board from a command that named nothing.
  // (`--all` below is the other way to widen, and it reads the BOARD rather than any ledger.)
  const named = input.passes.find((pass) => pass.runId === input.namedRunId)
  if (named) {
    for (const serviceId of ledgerServiceIds(named.world)) {
      add(serviceId, { kind: 'named-by-pass', runId: named.runId })
    }
  }

  // `--all` adds whatever is left: every frame the board lists. Added LAST so a frame the two
  // questions above already claimed keeps naming the refusal it would have earned, which is the
  // reason worth reading; `whole-board` alone is what separates a frame no configured pass would
  // ever have touched from one this `.env` points at.
  if (input.all) {
    for (const service of services) add(service.serviceId, { kind: 'whole-board' })
  }

  // One task read per planned frame, sequentially: there is no by-many read on this surface, so a
  // configured plan costs the two calls its two frames need and a `--all` plan costs one per frame
  // the board lists, each landing in a stable order. Each is already paged through by the caller's
  // client, which is what keeps a frame's tail from being left under it.
  const frames: PlannedFrame[] = []
  for (const [serviceId, why] of reasons) {
    const listed = byId.get(serviceId)
    frames.push({
      serviceId,
      title: listed?.title ?? null,
      reasons: why,
      // Only a listed frame has tasks worth reading: an unlisted one answers 404 on the task list,
      // and asking anyway would turn "already gone" into a failure the plan cannot describe.
      tasks: listed ? await client.tasks(serviceId) : [],
      absent: !listed,
    })
  }

  const doomed = new Set(frames.map((frame) => frame.serviceId))
  const passes = input.passes.flatMap((pass): PlannedPass[] => {
    const serviceIds = ledgerServiceIds(pass.world)
    const holdsDoomed = serviceIds.some((serviceId) => doomed.has(serviceId))
    // A pass is in the plan when it NAMES state being deleted, or when it was named on the command
    // line. An unrelated pass's files are left alone: they are how somebody else resumes.
    //
    // `--all` takes every pass on disk, and that follows from what it deletes rather than from being
    // the widest flag: a board with no frames left holds nothing for any ledger to map, so a file
    // kept back is a run id `status` still lists and `latest` may still resolve to. `resolveRunId`
    // reads that as a pass to CONTINUE, `WorldStore` opens it onto a board where none of its frames
    // exist, and the result is a fresh pass wearing a finished pass's id: the same failure the
    // pointer removal below exists against, one file up. It also takes the passes the other branches
    // structurally cannot, since a ledger that is absent or malformed (a refused attempt) names no
    // frames at all.
    if (!input.all && !holdsDoomed && pass.runId !== input.namedRunId) return []
    return [
      {
        runId: pass.runId,
        paths: [pass.ledgerPath, pass.journalPath],
        serviceIds,
        unreclaimed: serviceIds.filter(
          (serviceId) => !doomed.has(serviceId) && byId.has(serviceId),
        ),
        issueUrl: pass.world?.intakeIssue?.url ?? null,
      },
    ]
  })

  // Repositories a frame in this plan backs BEYOND the two this configuration names, read off the
  // same `GET /api/v1/repos` rows the plan was built from. They keep their content exactly as the
  // configured pair does, and nothing else in the report would say so: the leftovers paragraph names
  // the pair from the `.env`, which under `--all` is a fraction of what was just emptied. Reachable
  // in the narrow scope too, since a frame can be in the plan for its TITLE while backing some
  // repository this `.env` never mentions.
  const extraRepos = repos
    .filter((repo) => repo.serviceId !== null && doomed.has(repo.serviceId))
    .filter(
      (repo) =>
        !sameRepo(repo, config.repoOwner, config.repos.backend) &&
        !sameRepo(repo, config.repoOwner, config.repos.frontend),
    )
    .map((repo) => `${repo.owner}/${repo.name}`)

  // The pointer goes when the pass it names is in the plan, and ALSO under `--all`, which clears
  // the directory: a pointer left behind there names a ledger that is gone (or, hand-edited, one
  // that never existed), and `ACCEPTANCE_RUN_ID=latest` then resolves onto a state directory with
  // no ledgers at all. That is the same "fresh pass wearing a finished pass's run id" the removal
  // exists against, one branch further out. Keyed on the FILE, so a directory with no pointer at
  // all is not announced as one about to lose it.
  const namesPlannedPass = latestRunId !== null && passes.some((pass) => pass.runId === latestRunId)
  return {
    scope: input.all ? 'whole-board' : 'configured',
    frames,
    stuck,
    unlinked,
    passes,
    pointer:
      input.latest !== null && (namesPlannedPass || input.all)
        ? { runId: latestRunId, path: input.latest.path }
        : null,
    leftovers: leftoversOf(config, passes, extraRepos, input.purgeProvider === true),
  }
}

/** What became of one planned frame. */
export type FrameOutcome =
  | { status: 'deleted' }
  /** The board did not list it, or answered 404: someone got there first, and that is a success. */
  | { status: 'absent' }
  /**
   * The deployment refused. `reason` is `details.reason` where the surface published one, which is
   * how "it still holds unfinished work" is told from "the key is not admin" without reading prose.
   */
  | { status: 'refused'; reason: string | null; detail: string }

export type FrameResult = {
  serviceId: string
  title: string | null
  outcome: FrameOutcome
  /** Task ids deleted under it, in order. */
  deletedTasks: readonly string[]
  /** Tasks that could not be deleted, each with why. */
  failedTasks: readonly { taskId: string; detail: string }[]
}

export type PassResult = {
  runId: string
  /** Files actually removed. */
  removed: readonly string[]
  /** Why the files were KEPT, when they were. */
  kept: string | null
}

export type ResetReport = {
  frames: readonly FrameResult[]
  passes: readonly PassResult[]
  pointerRemoved: boolean
  stuck: readonly StuckRepo[]
  /**
   * Carried through from the plan for the same reason {@link stuck} is: `--yes` is a SEPARATE
   * invocation, and it is the one every printed remedy ends with, so anything the preview states
   * about what this read could not see has to be stated again by the outcome or it is stated to
   * nobody. See {@link ResetPlan.unlinked}.
   */
  unlinked: readonly string[]
  leftovers: readonly string[]
}

/** The one thing the apply needs beyond the client: removing a file, reporting whether one was there. */
export type ResetFiles = { remove(path: string): boolean }

/**
 * Carry the plan out, reporting every outcome rather than stopping at the first failure.
 *
 * Unfinished tasks first, then their frame, and that order is the whole reason a reset is not one
 * call: the frame delete REFUSES while an unfinished task is under it, deliberately, so that a
 * caller which did not mean to discard work in flight cannot. Deleting those tasks is this command
 * saying it means it, and each task delete also stops whatever run was going under it. A FINISHED
 * task needs no call: the frame delete cascades its whole subtree, and only the unfinished ones are
 * what the refusal counts.
 *
 * A failure is collected and the reset carries on to the next frame, for the same reason the
 * prerequisite gate reports every problem at once: an operator clearing a board wants the whole
 * list, and a frame that refuses says nothing about the other one.
 */
export async function applyReset(
  client: ResetClient,
  files: ResetFiles,
  plan: ResetPlan,
): Promise<ResetReport> {
  const frames: FrameResult[] = []
  for (const frame of plan.frames) {
    frames.push(await resetFrame(client, frame))
  }

  const refused = new Set(
    frames.filter((frame) => frame.outcome.status === 'refused').map((frame) => frame.serviceId),
  )
  const passes: PassResult[] = plan.passes.map((pass) => {
    const kept = keepReason(pass, plan.stuck, refused)
    if (kept !== null) return { runId: pass.runId, removed: [], kept }
    return {
      runId: pass.runId,
      removed: pass.paths.filter((path) => files.remove(path)),
      kept: null,
    }
  })

  const pointer = plan.pointer
  const pointerRemoved = pointerGoes(pointer, passes) && files.remove(pointer.path)

  return {
    frames,
    passes,
    pointerRemoved,
    stuck: plan.stuck,
    unlinked: plan.unlinked,
    leftovers: plan.leftovers,
  }
}

/**
 * Why a pass's local files must be KEPT, or null.
 *
 * ONE rule with two readers, and that is the whole point of it being a function: the PREVIEW is
 * this command's stated safety property, so a plan that listed files under "to remove" which the
 * apply then keeps misstates an outcome it already knew. Everything but `refused` is knowable at
 * plan time, which is why the preview passes an EMPTY refused set rather than asking a laxer rule.
 *
 * The three reasons are one rule seen from three sides: a pass's ledger is the only thing that
 * maps a leftover frame back to a run id, so removing it while any frame it names survives strands
 * that frame with no pass for the next refusal to name and no id to resume, and the id was in the
 * file just deleted.
 */
function keepReason(
  pass: PlannedPass,
  stuck: readonly StuckRepo[],
  refused: ReadonlySet<string>,
): string | null {
  // A repository this reset could not free is held by a frame NO read here can name: `/api/v1`
  // withholds the id (homed elsewhere) or omits the frame entirely (archived), and the two answer
  // alike. So there is no id to match against a ledger, and the only honest disposition is that
  // some ledger in this plan holds the run id that reaches it. Checked FIRST because it applies to
  // passes whose own frames all went.
  if (stuck.length > 0) {
    const slugs = stuck.map((entry) => entry.slug).join(', ')
    return (
      `${slugs} could not be freed, and the frame still holding ` +
      `${stuck.length === 1 ? 'it' : 'them'} is one this key cannot name (an archived frame and a ` +
      `service homed on another board answer identically), so no ledger can be matched to it and ` +
      `none of them go`
    )
  }
  const stillThere = [
    ...new Set([
      ...pass.serviceIds.filter((serviceId) => refused.has(serviceId)),
      ...pass.unreclaimed,
    ]),
  ]
  if (stillThere.length === 0) return null
  return (
    `${stillThere.join(', ')} ${stillThere.length === 1 ? 'is' : 'are'} still on the board, and ` +
    `this ledger is the only thing that names pass ${pass.runId} as the owner`
  )
}

/**
 * Whether the `latest` pointer goes with what is being removed.
 *
 * Left behind while its pass's files are gone, `ACCEPTANCE_RUN_ID=latest` resolves to a ledger
 * that no longer exists, which `resolveRunId` reads as a pass to CONTINUE and `WorldStore` then
 * opens empty: a fresh pass wearing a finished pass's run id, and nothing about it looks wrong from
 * the outside. Keyed on that pass's files being GONE rather than on any removal having happened, so
 * a pointer whose pass was kept (a frame survived) keeps pointing at a resume that still works.
 *
 * A pointer naming NO pass in this plan (`runId: null`, or an id whose ledger someone removed by
 * hand) can strand nobody, so it goes: `planReset` puts it here only under `--all`, which is the
 * scope that clears the directory it would otherwise outlive.
 */
function pointerGoes(
  pointer: ResetPlan['pointer'],
  passes: readonly { runId: string; kept: string | null }[],
): pointer is { runId: string | null; path: string } {
  if (pointer === null) return false
  const owner = passes.find((pass) => pass.runId === pointer.runId)
  return owner === undefined || owner.kept === null
}

async function resetFrame(client: ResetClient, frame: PlannedFrame): Promise<FrameResult> {
  const base = { serviceId: frame.serviceId, title: frame.title }
  if (frame.absent) {
    return { ...base, outcome: { status: 'absent' }, deletedTasks: [], failedTasks: [] }
  }
  const deletedTasks: string[] = []
  const failedTasks: { taskId: string; detail: string }[] = []
  // Only the UNFINISHED ones, because only those are what the frame delete refuses over. The frame
  // delete cascades its whole subtree, so a `done` task needs no call of its own, and a finished
  // pass leaves dozens of them per frame: each individual delete costs the deployment a full board
  // read on both of its own steps, for work the one frame delete does anyway.
  for (const task of frame.tasks.filter((entry) => !entry.done)) {
    try {
      await client.deleteTask(task.taskId)
      deletedTasks.push(task.taskId)
    } catch (error) {
      // A task already gone is a success: the reset wants it absent, and a resumed attempt or a
      // person in the app may have got there first.
      if (error instanceof CatFactoryNotFoundError) deletedTasks.push(task.taskId)
      else failedTasks.push({ taskId: task.taskId, detail: describeThrown(error) })
    }
  }
  try {
    await client.deleteService(frame.serviceId)
    return { ...base, outcome: { status: 'deleted' }, deletedTasks, failedTasks }
  } catch (error) {
    if (error instanceof CatFactoryNotFoundError) {
      return { ...base, outcome: { status: 'absent' }, deletedTasks, failedTasks }
    }
    return {
      ...base,
      outcome: {
        status: 'refused',
        reason: refusalReason(error),
        detail: describeThrown(error),
      },
      deletedTasks,
      failedTasks,
    }
  }
}

/**
 * The machine-readable half of a refusal, or null.
 *
 * Read off `details.reason` and never inferred from the status: `422` covers every validation
 * refusal this call can earn, and the one that has a different fix
 * (`service_has_unfinished_tasks`, meaning a task the reset did not see is still open) is told
 * apart only by the code.
 */
function refusalReason(error: unknown): string | null {
  if (!(error instanceof CatFactoryValidationError)) return null
  const details: unknown = error.details
  if (typeof details !== 'object' || details === null) return null
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

/** The service ids one ledger names. Total: an absent or malformed ledger names none. */
function ledgerServiceIds(world: World | null): readonly string[] {
  if (!world) return []
  return [world.backend, world.frontend].flatMap((service) => (service ? [service.serviceId] : []))
}

/**
 * Whether the reset did everything it planned.
 *
 * A refused frame or a task that would not delete leaves the board in the state the next pass will
 * be refused over, so it is a FAILING exit code rather than a note at the end of a report someone
 * ran headlessly and did not read.
 *
 * A repository this reset could NOT free counts the same way, and that is not a technicality: a
 * clear whose only blocker is an unfreeable repository deletes nothing, has nothing to report as
 * refused, and would otherwise exit 0 under "Done. A fresh pass can start" onto a board that earns
 * the identical `target-repos` refusal on the next attempt.
 */
export function resetSucceeded(report: ResetReport): boolean {
  return (
    report.stuck.length === 0 &&
    report.frames.every(
      (frame) => frame.outcome.status !== 'refused' && frame.failedTasks.length === 0,
    )
  )
}

/** The plan, as the preview an operator reads before adding `--yes`. */
export function formatResetPlan(plan: ResetPlan): string {
  const lines: string[] = []
  // Stated first and unconditionally under `--all`, because the two scopes render the SAME list on a
  // board that holds one pass, and the reading an operator does is the whole safety property.
  if (plan.scope === 'whole-board') {
    lines.push(
      `--all: the target is EVERY service frame this board lists, whatever backs it and whatever ` +
        `it is called, plus every pass in the state directory.`,
      '',
    )
  }
  if (plan.frames.length === 0) {
    lines.push(
      plan.scope === 'whole-board'
        ? 'This board lists no service frame at all, so there is nothing here to delete.'
        : 'No service frame on this board belongs to this configuration or the named pass.',
    )
  } else {
    lines.push(`Service frames to delete (${plan.frames.length}):`)
    for (const frame of plan.frames) {
      lines.push(`  ${describeFrame(frame)}`)
      for (const reason of frame.reasons) lines.push(`      because it ${describeReason(reason)}`)
      for (const task of frame.tasks) {
        lines.push(`      task ${task.taskId}: ${task.title}${task.done ? ' (done)' : ''}`)
      }
    }
  }
  // Split by the SAME retention rule the apply runs, with nothing refused yet, because everything
  // else it keys on is already known here. Listing a pass under "to remove" that the apply will
  // keep misstates an outcome this plan has computed, and the preview is the safety property.
  const outcome = plan.passes.map((pass) => ({ pass, kept: keepReason(pass, plan.stuck, EMPTY) }))
  const going = outcome.filter((entry) => entry.kept === null)
  const staying = outcome.filter((entry) => entry.kept !== null)
  if (going.length > 0) {
    lines.push('', `Local pass files to remove (${going.length} pass(es)):`)
    for (const { pass } of going) {
      lines.push(`  ${pass.runId}`)
      for (const path of pass.paths) lines.push(`      ${path}`)
    }
    lines.push(
      `  A frame whose delete is REFUSED keeps its pass's files too, which only the run can know.`,
    )
  }
  if (staying.length > 0) {
    lines.push('', `Local pass files KEPT (${staying.length} pass(es)):`)
    for (const { pass, kept } of staying) lines.push(`  ${pass.runId}: ${kept}`)
  }
  if (pointerGoes(plan.pointer, outcome.map(toPassOutcome))) {
    lines.push(
      '',
      plan.pointer.runId === null
        ? `The 'latest' pointer names no pass this directory holds, and --all clears the ` +
            `directory, so it goes too: ${plan.pointer.path}`
        : `The 'latest' pointer names ${plan.pointer.runId}, so it goes too: ${plan.pointer.path}`,
    )
  }
  return [
    ...lines,
    ...unlinkedLines(plan.unlinked),
    ...stuckLines(plan.stuck),
    ...leftoverLines(plan.leftovers),
  ].join('\n')
}

/** No frame has been refused yet, which is what the PLAN knows. */
const EMPTY: ReadonlySet<string> = new Set()

function toPassOutcome(entry: { pass: PlannedPass; kept: string | null }): {
  runId: string
  kept: string | null
} {
  return { runId: entry.pass.runId, kept: entry.kept }
}

/** The outcome, per frame and per pass, with everything that refused stated as such. */
export function formatResetReport(report: ResetReport): string {
  const lines: string[] = []
  if (report.frames.length === 0) lines.push('No service frame needed deleting.')
  else lines.push('Service frames:')
  for (const frame of report.frames) {
    lines.push(`  ${describeFrame(frame)}: ${describeOutcome(frame)}`)
    for (const failed of frame.failedTasks) {
      lines.push(`      task ${failed.taskId} could NOT be deleted: ${failed.detail}`)
    }
  }
  if (report.passes.length > 0) {
    lines.push('', 'Local pass files:')
    for (const pass of report.passes) {
      lines.push(
        pass.kept === null
          ? `  ${pass.runId}: removed ${pass.removed.length} file(s)${
              pass.removed.length > 0 ? ` (${pass.removed.join(', ')})` : ''
            }`
          : `  ${pass.runId}: KEPT, because ${pass.kept}`,
      )
    }
  }
  if (report.pointerRemoved) lines.push('', "The 'latest' pointer was removed with its pass.")
  return [
    ...lines,
    ...unlinkedLines(report.unlinked),
    ...stuckLines(report.stuck),
    ...leftoverLines(report.leftovers),
  ].join('\n')
}

function describeFrame(frame: { serviceId: string; title: string | null }): string {
  return `${frame.serviceId}${frame.title === null ? '' : ` '${frame.title}'`}`
}

function describeReason(reason: FrameReason): string {
  if (reason.kind === 'backs-repo') return `backs '${reason.slug}'`
  if (reason.kind === 'holds-title') return `holds the title '${reason.title}'`
  if (reason.kind === 'named-by-pass') return `is named by pass ${reason.runId}'s ledger`
  return `is on this board, and --all clears every frame the board lists`
}

function describeOutcome(frame: FrameResult): string {
  const tasks = `${frame.deletedTasks.length} unfinished task(s) cleared first`
  if (frame.outcome.status === 'deleted') return `deleted with everything under it, ${tasks}`
  if (frame.outcome.status === 'absent') {
    // "Already gone" would be a guess: this read cannot see an ARCHIVED frame either, and an
    // archived one still holds its repository projection, which is what the next pass is refused
    // over. Both are named, and the repository half is reported as `stuck` when it applies.
    return (
      `not listed by this board, so nothing was deleted: it is already gone, or ARCHIVED, which ` +
      `this key can neither see nor delete (${tasks})`
    )
  }
  const reason = frame.outcome.reason ? ` [${frame.outcome.reason}]` : ''
  return `REFUSED${reason}: ${frame.outcome.detail}`
}

/**
 * The configured repositories this workspace has not linked, so the plan could not ask what backs
 * them. See {@link ResetPlan.unlinked}: printed so an empty plan is not read as a clean board.
 */
function unlinkedLines(unlinked: readonly string[]): readonly string[] {
  if (unlinked.length === 0) return []
  return [
    '',
    `Not linked to this workspace, so GET /api/v1/repos says nothing about what backs ` +
      `${unlinked.length === 1 ? 'it' : 'them'}: ${unlinked.join(', ')}. Nothing here needs ` +
      `clearing for ${unlinked.length === 1 ? 'it' : 'them'}; spec 01 adopts a reachable ` +
      `repository itself, and if one is spoken for on ANOTHER board the target-repos gate is what ` +
      `says so.`,
  ]
}

/**
 * The repositories no reset can free, with the steps for each.
 *
 * Printed with the PLAN and again with the REPORT, because a reset that cleared everything it could
 * still leaves this refusal standing, and an operator reading only the outcome would re-run the pass
 * and hit the same gate.
 */
function stuckLines(stuck: readonly StuckRepo[]): readonly string[] {
  if (stuck.length === 0) return []
  return [
    '',
    'This reset cannot free:',
    ...stuck.flatMap((entry) => [`  ${entry.slug}`, ...entry.steps.map((step) => `      ${step}`)]),
  ]
}

function leftoverLines(leftovers: readonly string[]): readonly string[] {
  return ['', 'What a reset does NOT reclaim:', ...leftovers.map((note) => `  - ${note}`)]
}

/**
 * What a reset leaves behind, always stated.
 *
 * Every entry here is something an `/api/v1` key cannot reclaim, and each one changes what the next
 * pass does. The repositories are the load-bearing one: `target-repos` says outright that it cannot
 * read whether a repository is EMPTY, so a board reset against two scaffolded repositories passes
 * every prerequisite and then runs a scaffold on top of a tree that is already built.
 */
function leftoversOf(
  config: BoardConfig,
  passes: readonly PlannedPass[],
  extraRepos: readonly string[],
  purgeProvider: boolean,
): readonly string[] {
  const issues = passes.flatMap((pass) =>
    pass.issueUrl ? [`${pass.runId}: ${pass.issueUrl}`] : [],
  )
  // With `--purge-repos` the two sentences below are the ones this run is actively disproving, so
  // they are replaced rather than softened: the repository half is reported by the purge itself,
  // recovery command included, and repeating "it keeps its content" beside that would contradict it.
  if (purgeProvider) {
    return [
      // The purge only ever touches the two repositories the `.env` names, so under `--all` this is
      // the ONE thing about repositories that is still unreclaimed, and dropping it here would let a
      // purge report be read as covering every repository the plan just deleted a frame for.
      ...(extraRepos.length > 0
        ? [
            `${extraRepos.join(', ')} ${extraRepos.length === 1 ? 'backs a frame' : 'back frames'} ` +
              `this plan deletes and ${extraRepos.length === 1 ? 'is' : 'are'} NOT purged: ` +
              `--purge-repos empties only the two repositories this configuration points at. ` +
              `${extraRepos.length === 1 ? 'It keeps its' : 'They keep their'} content, branches ` +
              `and open pull requests.`,
          ]
        : []),
      `Whatever a purged repository held is in its own history, NOT here: the purge commits on top ` +
        `of the previous tip and tags every ref it touches, so the recovery command it prints is ` +
        `the authority on putting one back.`,
      `Per-PR namespaces on the cluster (ACCEPTANCE_K3S_NAMESPACE_TEMPLATE) are not touched. A run ` +
        `that finished reclaimed its own; one that was killed may have left a namespace behind, and ` +
        `only kubectl can see which.`,
    ]
  }
  return [
    ...(extraRepos.length > 0
      ? [
          `${extraRepos.join(', ')} ${extraRepos.length === 1 ? 'backs a frame' : 'back frames'} ` +
            `this plan deletes and ${extraRepos.length === 1 ? 'keeps its' : 'keep their'} content ` +
            `too. The paragraph below names only the two repositories this configuration points at, ` +
            `which is not the same set once a plan reaches frames it never adopted.`,
        ]
      : []),
    `The two repositories keep their CONTENT. ` +
      `'${config.repoOwner}/${config.repos.backend}' and ` +
      `'${config.repoOwner}/${config.repos.frontend}' still hold whatever a previous pass ` +
      `scaffolded, plus its branches and open pull requests, and no /api/v1 call can empty them. ` +
      `A fresh pass scaffolds ON TOP of that, which is a strange result rather than a failure: ` +
      `empty them yourself (or point ACCEPTANCE_BACKEND_REPO / ACCEPTANCE_FRONTEND_REPO at two ` +
      `fresh repositories) if you want the pass a first run would have.`,
    ...(issues.length > 0
      ? [
          issues.length === 1
            ? `The issue spec 04 filed as the REPORTER stays open on the provider, because it was ` +
              `never the platform's to close: ${issues[0]}. Close it with the account that filed it.`
            : `The ${issues.length} issues spec 04 filed as the REPORTER stay open on the ` +
              `provider, because they were never the platform's to close: ${issues.join('; ')}. ` +
              `Close them with the account that filed them.`,
        ]
      : []),
    `Per-PR namespaces on the cluster (ACCEPTANCE_K3S_NAMESPACE_TEMPLATE) are not touched. A run ` +
      `that finished reclaimed its own; one that was killed may have left a namespace behind, and ` +
      `only kubectl can see which.`,
  ]
}
