// Clearing a board back to "before any pass ran", as PLAN and APPLY, with the decisions that fail
// quietly owned here rather than re-made by every suite.
//
// A suite that files work through `/api/v1` accumulates state a second pass is then refused over: a
// repository that already backs a service frame, a title that is taken, a ledger naming a run whose
// frames are gone. The way out is to delete those frames, and `DELETE /api/v1/services/{id}` makes
// that headless. What is NOT obvious is the surrounding discipline, and four of its rules are the
// reason this module exists rather than a `deleteService` loop in each suite:
//
//   1. **Write order.** The frame delete REFUSES while an unfinished task sits under it, on purpose,
//      so a caller that did not mean to discard work in flight cannot. Those tasks go first. A
//      FINISHED task needs no call of its own: the frame delete cascades its whole subtree, and a
//      completed pass leaves dozens per frame, each individual delete costing a whole-board read for
//      work the one frame delete does anyway.
//   2. **Never orphan a ledger.** A pass's ledger is the only thing that maps a leftover frame back
//      to a run id. Removing it while any frame it names is still standing strands that frame with
//      no pass to resume and no id to resume it by, and the id was in the file just deleted. That is
//      the exact state a reset exists to get an operator OUT of, so a pass whose frame refused, or
//      whose blocker could not be freed, keeps its files.
//   3. **The `latest` pointer.** It goes when it names a pass being removed, and ALSO when it names
//      nothing: a dangling pointer outlives every ledger in the directory and then resolves a
//      `latest` resume onto a state directory holding none, which reads as a fresh pass wearing a
//      finished pass's run id.
//   4. **Plan, then apply the PLAN.** The preview is the safety property, so the apply consumes the
//      plan rather than re-deriving a target that the preview never showed anybody. It also means
//      the plan has to run the same retention rule the apply will (see {@link keepReason}), or it
//      lists a file under "to remove" that the apply then keeps.
//
// And a fifth that is a disposition rather than a rule: **404 is an outcome, not a failure.**
// Something else got there first, which is what the reset wanted.
//
// What a SUITE owns, because none of it is knowable from here: which frames this configuration
// targets and in whose words (`ResetInput.target`), which of its own service ids one ledger names
// (`ResetInput.ledgerServiceIds`), and what a reset does not reclaim (`ResetInput.leftovers`). The
// worked consumer is `backend/internal/acceptance/src/reset.ts` in the cat-factory repository.

import { CatFactoryNotFoundError, CatFactoryValidationError } from '@cat-factory/sdk'
import { describeThrown } from './operatorText.js'
import type { LatestPointer } from './passFiles.js'

/**
 * The command line, or the refusal naming what was passed.
 *
 * Here rather than in a suite's CLI module because a CLI module is a SCRIPT: importing one to test
 * its parser runs the whole command, deployment reads and `process.exit` included.
 *
 * A positional that looks like a flag is REFUSED rather than taken as a run id. A mistyped
 * `--dry-run` read as a positional reports on a pass by that name and answers "no such pass", which
 * reads as a broken state directory; here the same slip is worse, because the flag being reached for
 * is the one that decides whether anything is deleted.
 *
 * `--yes` and `--all` are this module's own, because it acts on both. Anything else a suite's reset
 * carries is declared in `options.flags` and handed back in {@link ResetArgs.flags} un-interpreted: a
 * flag the kit does not act on is a flag the kit may not guess the meaning of, and silently ignoring
 * one is how a reset runs a narrower job than the operator asked for while reporting success.
 */
export function parseResetArgs(
  argv: readonly string[],
  options: {
    /** The whole usage line, e.g. `my-reset [runId|latest] [--all] [--yes]`. Quoted on a refusal. */
    usage: string
    /** Suite flags to accept, spelled as they are typed (`--purge-repos`). */
    flags?: readonly string[]
  },
):
  | { ok: true; runId: string | null; all: boolean; apply: boolean; flags: ReadonlySet<string> }
  | {
      ok: false
      problem: string
    } {
  const suiteFlags = new Set(options.flags ?? [])
  const seen = new Set<string>()
  let runId: string | null = null
  let apply = false
  let all = false
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') {
      apply = true
      continue
    }
    if (arg === '--all') {
      all = true
      continue
    }
    if (suiteFlags.has(arg)) {
      seen.add(arg)
      continue
    }
    if (arg.startsWith('-')) {
      return { ok: false, problem: `unknown option '${arg}'. Usage: ${options.usage}` }
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
  return { ok: true, runId, all, apply, flags: seen }
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
   * Carried rather than derived from the status vocabulary here, because it decides which tasks are
   * deleted one by one: only the unfinished ones are what the frame delete refuses over, and the
   * rest ride its cascade (see rule 1 in this module's header).
   */
  done: boolean
}

/**
 * What a reset needs from the deployment, narrowed to the four calls it makes.
 *
 * A port rather than the SDK client so the whole flow is drivable with no deployment, and so a test
 * can assert the ORDER of the writes, which is the property that matters most here and the one an
 * integration test would be the most expensive way to check.
 *
 * Whatever ELSE a suite reads to decide its target (repository rows, an issue tracker) it reads
 * itself, inside {@link ResetInput.target}: those reads differ per suite and naming them here would
 * make the port describe one suite's questions.
 */
export type ResetClient = {
  services(): Promise<readonly ResetServiceRow[]>
  /** Every task under a frame, across pages. */
  tasks(serviceId: string): Promise<readonly ResetTaskRow[]>
  deleteTask(taskId: string): Promise<void>
  deleteService(serviceId: string): Promise<void>
}

/**
 * Something a reset cannot free, which is why it is not simply reported and passed over.
 *
 * A blocker does two things beyond printing: it keeps EVERY pass's files (rule 2, because whatever
 * still holds it is a frame no read here can name, so no ledger can be matched to it), and it makes
 * {@link resetSucceeded} false, so a clear whose only obstacle is one of these does not exit 0 under
 * "done" onto a board that earns the identical refusal on the next attempt.
 */
export type ResetBlocker = {
  /** What could not be freed, as one line names it (a repository slug, a resource id). */
  subject: string
  /** The steps that WOULD free it, printed under the subject in both the plan and the report. */
  steps: readonly string[]
}

/** One frame a suite is targeting, with the phrase the plan prints after `because it `. */
export type TargetedFrame = {
  serviceId: string
  /**
   * Why, in the suite's own words, as a verb phrase: `backs 'acme/api'`, `holds the title 'X'`.
   *
   * The suite's rather than a vocabulary here, because the QUESTIONS differ per suite: one asks
   * about two repositories and a reporter issue, another about one repository and one title, and a
   * closed union would either name one suite's questions or degrade every reason to "targeted".
   * Several entries may name the same frame, and all of their phrases are printed.
   */
  because: string
}

/** What this configuration targets, and what it could not read or free while working that out. */
export type ResetTargeting = {
  frames: readonly TargetedFrame[]
  /** See {@link ResetBlocker}. Absent is the ordinary case. */
  blockers?: readonly ResetBlocker[]
  /**
   * Paragraphs printed with the plan AND the report, above the leftovers.
   *
   * For what this read could not SEE, which is the fact an empty plan otherwise swallows: "nothing
   * on this board matches" and "this read cannot answer for it" are different, and only the first
   * means a reset has nothing to do. Repeated by the report because `--yes` is a separate
   * invocation, so anything stated only by the preview is stated to nobody.
   */
  notes?: readonly string[]
}

/** One pass on disk, as the caller read it through `passFiles.ts` (the one owner of the layout). */
export type ResetPassOnDisk<Facts> = {
  runId: string
  ledgerPath: string
  journalPath: string
  /** Its ledger's facts, or null when the file is absent, malformed, or names a different pass. */
  facts: Facts | null
}

/** What {@link ResetInput.leftovers} is told about the plan it is describing. */
export type LeftoversContext<Facts> = {
  frames: readonly PlannedFrame[]
  passes: readonly PlannedPass<Facts>[]
}

export type ResetInput<Facts> = {
  /**
   * The pass named on the command line, or null.
   *
   * Its own input rather than something derived from the state directory, because naming one WIDENS
   * the target: a pass whose ledger holds frames this configuration no longer points at (the
   * configuration moved on, the prefix changed) is otherwise unreachable, and clearing it is
   * precisely what someone naming it is asking for.
   */
  namedRunId: string | null
  /**
   * `--all`: target every frame the board lists, rather than the questions this configuration asks.
   *
   * Its own field rather than a mode threaded through {@link target}, because it does not widen
   * those questions: they ask what would be REFUSED, and this asks what is THERE. Keeping them
   * separate is what lets a frame in the plan for both reasons still state both.
   */
  all: boolean
  passes: readonly ResetPassOnDisk<Facts>[]
  /**
   * The `latest` pointer file, or null when there is none.
   *
   * The FILE rather than what it resolves to, because a pointer naming nothing is a state a cleanup
   * has to act on: see {@link LatestPointer} and rule 3 in this module's header.
   */
  latest: LatestPointer | null
  /**
   * What this configuration targets, given the frames the board lists.
   *
   * Handed the services read rather than left to make its own, because the plan needs that list
   * anyway (to tell a frame that is absent from one that is merely untargeted) and two reads of it
   * could disagree. Any OTHER read a suite's questions need it makes itself, here.
   */
  target(services: readonly ResetServiceRow[]): ResetTargeting | Promise<ResetTargeting>
  /**
   * The service ids ONE pass's ledger names.
   *
   * Total over the suite's fact type: a ledger recording nothing yet names no frame. This is what a
   * named pass widens the plan by, and what rule 2 matches a surviving frame against.
   */
  ledgerServiceIds(facts: Facts): readonly string[]
  /**
   * What a reset does NOT reclaim, one sentence each.
   *
   * Per suite by nature, and load-bearing rather than a footer: a board cleared of frames whose
   * repositories still hold everything a previous pass scaffolded reads as a FRESH board, and the
   * next pass then builds on top of a tree that is already built. Answering none of these is
   * stated as such rather than rendered as an empty section.
   */
  leftovers(context: LeftoversContext<Facts>): readonly string[]
}

/** Why a frame is in the plan. Several can be true of one frame, and all of them are stated. */
export type FrameReason =
  | { kind: 'targeted'; because: string }
  | { kind: 'named-by-pass'; runId: string }
  | { kind: 'whole-board' }

export type PlannedFrame = {
  serviceId: string
  /** As the board reports it, or null for a frame only a ledger names (already gone, or archived). */
  title: string | null
  reasons: readonly FrameReason[]
  tasks: readonly ResetTaskRow[]
  /** True when the services read does not list it, so there is nothing here to delete. */
  absent: boolean
}

export type PlannedPass<Facts> = {
  runId: string
  /** The files that would go. */
  paths: readonly string[]
  /** The frames its ledger names, so the apply can keep its files when one survives. */
  serviceIds: readonly string[]
  /**
   * The frames its ledger names that the board still LISTS and this plan does not target.
   *
   * The state that makes this necessary: a pass holding two frames, only one of which this
   * configuration still points at. The plan takes the one, and removing the ledger would strand the
   * other with nothing naming its owner, which is rule 2 exactly. Empty by construction for a pass
   * named on the command line, since naming one adds everything its ledger holds to the plan.
   */
  unreclaimed: readonly string[]
  /**
   * Its ledger's facts, carried through so {@link ResetInput.leftovers} can name what only they
   * record.
   *
   * Carried rather than looked up again at report time, because deleting the ledger is what makes
   * it unrecoverable: this is the last moment anything knows what was in it.
   */
  facts: Facts | null
}

export type ResetPlan<Facts> = {
  /**
   * Which question built the frame list: this configuration's, or `--all`.
   *
   * Carried on the plan rather than left to the caller that passed the flag, because the PREVIEW is
   * what an operator grades a whole-board clear on, and "every frame on this board" and "the frames
   * this configuration points at" are the same list on a board holding only one pass. A preview that
   * cannot tell those apart reads as the narrow one, which is the reading that makes `--yes` a
   * surprise.
   */
  scope: 'configured' | 'whole-board'
  frames: readonly PlannedFrame[]
  blockers: readonly ResetBlocker[]
  /** See {@link ResetTargeting.notes}. */
  notes: readonly string[]
  passes: readonly PlannedPass<Facts>[]
  /**
   * The `latest` pointer, when this reset would remove it: it names a pass in this plan, or the
   * scope is `--all` (which clears the state directory, so a pointer naming a pass that is no longer
   * there goes with it). `runId` is null for a pointer that names nothing readable.
   */
  pointer: { runId: string | null; path: string } | null
  /** What a reset does NOT reclaim, from {@link ResetInput.leftovers}. */
  leftovers: readonly string[]
}

/**
 * What a reset WOULD do, from the board reads, the suite's questions and the state directory.
 *
 * Three sources of frames, unioned, because they answer different questions: the suite's own
 * targeting (what would be refused), a NAMED pass's ledger (what that pass created, wherever this
 * configuration now points), and `--all` (what is simply there). A frame reached by more than one
 * states every reason, and a plan built from one source alone leaves the others' refusals firing
 * after a reset reported success.
 */
export async function planReset<Facts>(
  client: ResetClient,
  input: ResetInput<Facts>,
): Promise<ResetPlan<Facts>> {
  const latestRunId = input.latest?.runId ?? null
  const services = await client.services()
  const byId = new Map(services.map((service) => [service.serviceId, service]))
  const targeting = await input.target(services)

  const reasons = new Map<string, FrameReason[]>()
  const add = (serviceId: string, reason: FrameReason): void => {
    const existing = reasons.get(serviceId)
    if (existing) existing.push(reason)
    else reasons.set(serviceId, [reason])
  }

  for (const frame of targeting.frames) {
    add(frame.serviceId, { kind: 'targeted', because: frame.because })
  }

  // A NAMED pass widens the target to whatever its own ledger holds. No OTHER ledger does anything:
  // the frames of a pass nobody named are already covered by the suite's own questions, and reaching
  // into every ledger on disk would clear a colleague's board from a command that named nothing.
  // (`--all` below is the other way to widen, and it reads the BOARD rather than any ledger.)
  const named = input.passes.find((pass) => pass.runId === input.namedRunId)
  if (named) {
    for (const serviceId of ledgerIdsOf(input, named)) {
      add(serviceId, { kind: 'named-by-pass', runId: named.runId })
    }
  }

  // `--all` adds whatever is left: every frame the board lists. Added LAST so a frame the questions
  // above already claimed keeps naming the refusal it would have earned, which is the reason worth
  // reading; `whole-board` alone is what separates a frame no configured pass would ever have
  // touched from one this configuration points at.
  if (input.all) {
    for (const service of services) add(service.serviceId, { kind: 'whole-board' })
  }

  // One task read per planned frame, sequentially: there is no by-many read on this surface, so a
  // configured plan costs the calls its own frames need and a `--all` plan costs one per frame the
  // board lists, each landing in a stable order. Each is already paged through by the caller's
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
  const passes = input.passes.flatMap((pass): PlannedPass<Facts>[] => {
    const serviceIds = ledgerIdsOf(input, pass)
    const holdsDoomed = serviceIds.some((serviceId) => doomed.has(serviceId))
    // A pass is in the plan when it NAMES state being deleted, or when it was named on the command
    // line. An unrelated pass's files are left alone: they are how somebody else resumes.
    //
    // `--all` takes every pass on disk, and that follows from what it deletes rather than from being
    // the widest flag: a board with no frames left holds nothing for any ledger to map, so a file
    // kept back is a run id a status report still lists and `latest` may still resolve to, which
    // reads as a pass to CONTINUE and opens onto a board where none of its frames exist. That is the
    // same failure rule 3 exists against, one file up. It also takes the passes the other branches
    // structurally cannot, since a ledger that is absent or malformed names no frames at all.
    if (!input.all && !holdsDoomed && pass.runId !== input.namedRunId) return []
    return [
      {
        runId: pass.runId,
        paths: [pass.ledgerPath, pass.journalPath],
        serviceIds,
        unreclaimed: serviceIds.filter(
          (serviceId) => !doomed.has(serviceId) && byId.has(serviceId),
        ),
        facts: pass.facts,
      },
    ]
  })

  // The pointer goes when the pass it names is in the plan, and ALSO under `--all`, which clears the
  // directory: a pointer left behind there names a ledger that is gone (or, hand-edited, one that
  // never existed). Keyed on the FILE, so a directory with no pointer at all is not announced as one
  // about to lose it.
  const namesPlannedPass = latestRunId !== null && passes.some((pass) => pass.runId === latestRunId)
  return {
    scope: input.all ? 'whole-board' : 'configured',
    frames,
    blockers: targeting.blockers ?? [],
    notes: targeting.notes ?? [],
    passes,
    pointer:
      input.latest !== null && (namesPlannedPass || input.all)
        ? { runId: latestRunId, path: input.latest.path }
        : null,
    leftovers: input.leftovers({ frames, passes }),
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
  /**
   * Carried through from the plan, with {@link notes}, for one reason: `--yes` is a SEPARATE
   * invocation, and it is the one every printed remedy ends with, so anything the preview stated
   * about what this read could not see or free has to be stated again by the outcome or it is
   * stated to nobody.
   */
  blockers: readonly ResetBlocker[]
  notes: readonly string[]
  leftovers: readonly string[]
}

/** The one thing the apply needs beyond the client: removing a file, reporting whether one was there. */
export type ResetFiles = { remove(path: string): boolean }

/**
 * Carry the plan out, reporting every outcome rather than stopping at the first failure.
 *
 * Unfinished tasks first, then their frame (rule 1). Deleting those tasks is this command saying it
 * means it, and each task delete also stops whatever run was going under it.
 *
 * A failure is collected and the reset carries on to the next frame: an operator clearing a board
 * wants the whole list, and a frame that refuses says nothing about the next one.
 */
export async function applyReset<Facts>(
  client: ResetClient,
  files: ResetFiles,
  plan: ResetPlan<Facts>,
): Promise<ResetReport> {
  const frames: FrameResult[] = []
  for (const frame of plan.frames) {
    frames.push(await resetFrame(client, frame))
  }

  const refused = new Set(
    frames.filter((frame) => frame.outcome.status === 'refused').map((frame) => frame.serviceId),
  )
  const passes: PassResult[] = plan.passes.map((pass) => {
    const kept = keepReason(pass, plan.blockers, refused)
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
    blockers: plan.blockers,
    notes: plan.notes,
    leftovers: plan.leftovers,
  }
}

/**
 * Why a pass's local files must be KEPT, or null: rule 2, as one function with two readers.
 *
 * Two readers is the whole point of it being a function. The PREVIEW is this command's stated safety
 * property, so a plan listing files under "to remove" which the apply then keeps misstates an outcome
 * it already knew. Everything but `refused` is knowable at plan time, which is why the preview passes
 * an EMPTY refused set rather than asking a laxer rule.
 *
 * The three reasons are one rule seen from three sides: a pass's ledger is the only thing that maps a
 * leftover frame back to a run id.
 */
function keepReason<Facts>(
  pass: PlannedPass<Facts>,
  blockers: readonly ResetBlocker[],
  refused: ReadonlySet<string>,
): string | null {
  // A blocker is held by a frame NO read here can name, so there is no id to match against a ledger,
  // and the only honest disposition is that some ledger in this plan holds the run id that reaches
  // it. Checked FIRST because it applies to passes whose own frames all went. The steps that WOULD
  // free it are printed under it, in this same output.
  if (blockers.length > 0) {
    const subjects = blockers.map((entry) => entry.subject).join(', ')
    return (
      `${subjects} could not be freed, and whatever still holds ` +
      `${blockers.length === 1 ? 'it' : 'them'} is a frame this reset cannot name, so no ledger ` +
      `can be matched to it and none of them go`
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
 * Whether the `latest` pointer goes with what is being removed: rule 3.
 *
 * Keyed on that pass's files being GONE rather than on any removal having happened, so a pointer
 * whose pass was kept (a frame survived) keeps pointing at a resume that still works.
 *
 * A pointer naming NO pass in this plan (`runId: null`, or an id whose ledger someone removed by
 * hand) can strand nobody, so it goes: `planReset` puts it here only under `--all`, which is the
 * scope that clears the directory it would otherwise outlive.
 */
function pointerGoes(
  pointer: { runId: string | null; path: string } | null,
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
  // Only the UNFINISHED ones: see rule 1.
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
      outcome: { status: 'refused', reason: refusalReason(error), detail: describeThrown(error) },
      deletedTasks,
      failedTasks,
    }
  }
}

/**
 * The machine-readable half of a refusal, or null.
 *
 * Read off `details.reason` and never inferred from the status: `422` covers every validation
 * refusal this call can earn, and the one with a different fix (a task the reset did not see is
 * still open) is told apart only by the code.
 */
function refusalReason(error: unknown): string | null {
  if (!(error instanceof CatFactoryValidationError)) return null
  const details: unknown = error.details
  if (typeof details !== 'object' || details === null) return null
  const reason = (details as { reason?: unknown }).reason
  return typeof reason === 'string' ? reason : null
}

/** The service ids one pass's ledger names. Total: a pass with no readable ledger names none. */
function ledgerIdsOf<Facts>(
  input: ResetInput<Facts>,
  pass: ResetPassOnDisk<Facts>,
): readonly string[] {
  return pass.facts === null ? [] : input.ledgerServiceIds(pass.facts)
}

/**
 * Whether the reset did everything it planned.
 *
 * A refused frame or a task that would not delete leaves the board in the state the next pass will
 * be refused over, so it is a FAILING exit code rather than a note at the end of a report someone
 * ran headlessly and did not read.
 *
 * A blocker counts the same way, and that is not a technicality: a clear whose only obstacle is one
 * deletes nothing, has nothing to report as refused, and would otherwise exit 0 under "done" onto a
 * board that earns the identical refusal on the next attempt.
 */
export function resetSucceeded(report: ResetReport): boolean {
  return (
    report.blockers.length === 0 &&
    report.frames.every(
      (frame) => frame.outcome.status !== 'refused' && frame.failedTasks.length === 0,
    )
  )
}

/** The plan, as the preview an operator reads before adding `--yes`. */
export function formatResetPlan<Facts>(plan: ResetPlan<Facts>): string {
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
  // else it keys on is already known here. Listing a pass under "to remove" that the apply will keep
  // misstates an outcome this plan has computed, and the preview is the safety property.
  const outcome = plan.passes.map((pass) => ({
    pass,
    kept: keepReason(pass, plan.blockers, EMPTY),
  }))
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
    ...noteLines(plan.notes),
    ...blockerLines(plan.blockers),
    ...leftoverLines(plan.leftovers),
  ].join('\n')
}

/** No frame has been refused yet, which is what the PLAN knows. */
const EMPTY: ReadonlySet<string> = new Set()

function toPassOutcome<Facts>(entry: { pass: PlannedPass<Facts>; kept: string | null }): {
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
    ...noteLines(report.notes),
    ...blockerLines(report.blockers),
    ...leftoverLines(report.leftovers),
  ].join('\n')
}

function describeFrame(frame: { serviceId: string; title: string | null }): string {
  return `${frame.serviceId}${frame.title === null ? '' : ` '${frame.title}'`}`
}

function describeReason(reason: FrameReason): string {
  if (reason.kind === 'targeted') return reason.because
  if (reason.kind === 'named-by-pass') return `is named by pass ${reason.runId}'s ledger`
  return `is on this board, and --all clears every frame the board lists`
}

function describeOutcome(frame: FrameResult): string {
  const tasks = `${frame.deletedTasks.length} unfinished task(s) cleared first`
  if (frame.outcome.status === 'deleted') return `deleted with everything under it, ${tasks}`
  if (frame.outcome.status === 'absent') {
    // "Already gone" would be a guess: this read cannot see an ARCHIVED frame either, and an
    // archived one still holds whatever projection the next pass is refused over. Both are named.
    return (
      `not listed by this board, so nothing was deleted: it is already gone, or ARCHIVED, which ` +
      `this key can neither see nor delete (${tasks})`
    )
  }
  const reason = frame.outcome.reason ? ` [${frame.outcome.reason}]` : ''
  return `REFUSED${reason}: ${frame.outcome.detail}`
}

/** See {@link ResetTargeting.notes}: printed so an empty plan is not read as a clean board. */
function noteLines(notes: readonly string[]): readonly string[] {
  return notes.flatMap((note) => ['', note])
}

/**
 * The blockers no reset can free, with the steps for each.
 *
 * Printed with the PLAN and again with the REPORT, because a reset that cleared everything it could
 * still leaves this refusal standing, and an operator reading only the outcome would re-run the pass
 * and hit the same gate.
 */
function blockerLines(blockers: readonly ResetBlocker[]): readonly string[] {
  if (blockers.length === 0) return []
  return [
    '',
    'This reset cannot free:',
    ...blockers.flatMap((entry) => [
      `  ${entry.subject}`,
      ...entry.steps.map((step) => `      ${step}`),
    ]),
  ]
}

/**
 * What a reset leaves behind, always a section.
 *
 * A suite that states nothing says so, rather than rendering a header with nothing under it: an
 * empty section reads exactly like a reset that reclaimed everything, which is the one reading this
 * paragraph exists to prevent.
 */
function leftoverLines(leftovers: readonly string[]): readonly string[] {
  if (leftovers.length === 0) {
    return [
      '',
      'What a reset does NOT reclaim: this suite names nothing. Anything it provisioned outside ' +
        'the board is not covered by the lines above.',
    ]
  }
  return ['', 'What a reset does NOT reclaim:', ...leftovers.map((note) => `  - ${note}`)]
}
