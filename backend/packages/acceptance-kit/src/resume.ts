// RESUMING a scenario that files work: adopt what a previous pass started, rather than filing it again.
//
// The ledger has always remembered what a pass created, and scenario 01 has always re-read the board
// before bootstrapping. The scenarios that FILE WORK did not: each one created a task and started a
// run unconditionally, so a pass interrupted forty minutes into `pl_build` re-filed the same
// feature on the next attempt. That is the most expensive failure this suite can have. It spends
// the whole run again, and it does something worse than waste money: two runs against one
// repository's default branch race on the same branch, which is the exact collision the platform's
// own task-dependency edges exist to prevent.
//
// So a run is recorded at THREE points and re-read at all three: the task id the moment it is
// created, the run id the moment `start` returns it, and the pull request when the run settles.
// Recording the run id after the drive (the shape this replaced) leaves the one window that
// matters uncovered, because the window IS the drive.
//
// **What resuming never does is assume.** Every adoption re-reads the deployment: a ledger naming
// a task the board no longer holds files a fresh one and says so, and a run that is still working
// is re-attached to rather than restarted.
//
// **The create itself is the one point no ordering can cover**, because the id is minted on the far
// side of it (README rule 9). A create whose answer is lost leaves a task no ledger names, and the
// next pass files a second one against the same default branch. Closing that needs a
// caller-supplied idempotency key on `/api/v1`, which is a permanent shape on a frozen surface and
// a decision of its own; what this module owes meanwhile is to SAY so, and to say it only when the
// failure supports it. `createFailure` is that, and the SDK's own diagnosis is what makes the
// distinction available (ADR 0060).
//
// Saying it only when the failure supports it takes TWO narrowings, because the window is bounded
// by what the request was, not by where the code that failed sat. `isRequestFailure` keeps out
// everything the suite threw on the way to a create, and `prepareTask` is where a body's own READS
// go, so a create window holds a create.

import type { ConnectionFailureCause } from '@cat-factory/kernel'
import {
  CatFactoryApiError,
  type CatFactoryClient,
  CatFactoryConnectionError,
  CatFactoryDecodeError,
  CatFactoryNotFoundError,
  CatFactoryTimeoutError,
  type PublicRun,
} from '@cat-factory/sdk'
import { type CredentialRetry, describeRun, isTerminal } from './client.js'
import type { Journal } from './journal.js'
import { OperatorRefusal } from './operatorText.js'
import { describeProbeFailure, isIntermediaryStatus, type ProbeFailure } from './probeFailure.js'
import { type DriveResult, driveRun } from './runDriver.js'

/**
 * One piece of work a pass filed, as its LEDGER remembers it.
 *
 * Three ids rather than one because a pass is interrupted between them, and each answers a
 * different question on the way back in: the task exists, a run was started for it, a pull request
 * came out of it.
 */
export type RunRecord = {
  taskId: string
  runId: string | null
  pullRequestUrl: string | null
  /**
   * The decision kinds a suite answered on the run, accumulated across attempts.
   *
   * The one entry here that is not an id, and the exception is deliberate: every other field names
   * something the DEPLOYMENT can be re-asked about, but "the suite answered a `clarity-review` gate
   * over /api/v1" is a fact about what the suite DID, and a settled decision is indistinguishable
   * afterwards from one that never had to be made. A scenario that asserts on it would otherwise
   * report a resumed pass as never having exercised the gate it exercised yesterday.
   */
  answeredKinds: readonly string[]
}

export type FileAndDriveOptions<Prepared = void> = {
  client: CatFactoryClient
  journal: Journal
  /** What a previous pass recorded for this piece of work, if anything. */
  existing: RunRecord | null
  /**
   * Anything the task body needs READ before it can be built, resolved outside the create window.
   *
   * Its own stage rather than the first half of {@link createTask}, because the two halves fail
   * differently and only one of them leaves a question behind. A read that fails on the way to
   * composing a description failed before any create was attempted, and reporting it as a create of
   * unknown fate sends an operator to search a board for a task nothing ever tried to file. That is
   * not a hypothetical shape: the description of scenario 04's bug report names the environment the
   * feature shipped to, which is an evidence read against the same deployment the create goes to,
   * and it fails in exactly the ways a create does.
   *
   * Called only when there is something to file, so the laziness that put those reads inside the
   * create callback is kept: a resumed pass that adopts an already-filed task still spends nothing.
   */
  prepareTask?: () => Promise<Prepared>
  /**
   * File the task, given whatever {@link prepareTask} resolved. Called only when there is nothing
   * to adopt.
   *
   * The suite's own call, because only it knows what to pin (its model preset, its task type, its
   * per-case fields). What it should NOT own is the size branch: a `description` is capped at 2,000
   * characters and a real scaffold brief is several times that, so build the body's brief half with
   * `briefFields` (`brief.ts`) rather than passing a brief straight through and discovering the
   * ceiling as a `422` on the first task of a pass.
   *
   * This callback is the CREATE WINDOW, and what it holds decides what a lost answer means: put
   * everything that merely BUILDS the request in `prepareTask`, so a failure here is a failure of
   * the request itself.
   */
  createTask: (prepared: Prepared) => Promise<{ taskId: string }>
  pipelineId: string
  steer: string
  budgetMs: number
  /**
   * Persist a record. Called at every point the record changes, and expected to write through
   * to the ledger synchronously: this callback is the only thing standing between an interrupted
   * run and an orphaned pull request nobody can find.
   */
  onRecord: (record: RunRecord) => void
  /** Human label for the work, used in every message. */
  label: string
  /**
   * How a write refused for want of a PER-USER credential is retried (`start`, here). Passed down
   * rather than read from a module global, because an implementation of it holds a secret for the
   * life of the process and a global would put that secret one import away from every file.
   *
   * REQUIRED, and a suite whose models are all reached with the deployment's own keys names
   * `passThroughCredentialRetry` explicitly. Optional, the omission was silent in the
   * direction that costs the most: a scenario copied from a sibling and missing this field
   * typechecks, passes every unit test, and then dies at the `start` a workspace answers `428` after
   * an afternoon of real spend, having never asked for the password it was about to be handed. It is
   * required for the reason `Scenario.gated` is: the decision is cheap to state and expensive to
   * forget.
   */
  credentials: CredentialRetry
  /**
   * The suite's own "nothing was cleaned up" tail, passed through to the run's waits. See
   * `DriveOptions.epilogue`, which is where the reason it is required lives.
   */
  epilogue: string
}

export type FileAndDriveResult = DriveResult & {
  record: RunRecord
  /**
   * Every decision kind answered on this run, INCLUDING those a previous attempt answered.
   *
   * The claim scenario 03 makes is "this suite answered a human gate over the public API", and that
   * claim is not weakened by the answering having happened before the process restarted. Reading
   * it off `answered` alone would report a resumed pass as never having exercised the gate.
   */
  answeredKinds: readonly string[]
}

/**
 * File a task (or adopt the one already filed), drive it to terminal, and record it throughout.
 *
 * The four states a resumed pass can find, each needing a different action:
 *
 *   1. **Nothing recorded.** File it, record, start, record, drive.
 *   2. **A task recorded, but the board has no such task.** Someone deleted it, or it was filed
 *      against a board that has since been reset. File it again, saying so.
 *   3. **A task recorded whose run already reached a terminal state.** Adopt it: the work is
 *      done, and re-running it would spend an afternoon to reach the state already in hand.
 *   4. **A task recorded whose run is still live.** Re-attach and keep driving it under a fresh
 *      budget. This is the case the whole module exists for.
 */
export async function fileAndDrive<Prepared = void>(
  options: FileAndDriveOptions<Prepared>,
): Promise<FileAndDriveResult> {
  const { journal, existing, label, onRecord } = options

  const adopted: Adoption = existing?.taskId ? await adopt(options, existing) : { kind: 'gone' }
  // Carried only onto work the ledger's own task still names. On the `gone` path the recorded task
  // is being re-filed, and its predecessor's gate answers are a fact about a run the board no
  // longer has: inheriting them would let scenario 03 claim it drove the clarity gate on a run that
  // never reached it, which is the one claim the ledger carries this set to make.
  const carried = adopted.kind === 'gone' ? [] : (existing?.answeredKinds ?? [])
  if (adopted.kind === 'settled') {
    journal.say(
      'milestone',
      `adopting the already-finished '${label}' from a previous pass: ${describeRun(adopted.run)}`,
    )
    const record = recordOf(adopted.run, adopted.taskId, carried)
    onRecord(record)
    return { run: adopted.run, answered: [], record, answeredKinds: carried }
  }

  const taskId = adopted.kind === 'gone' ? await fileTask(options) : adopted.taskId
  const live = adopted.kind === 'live' ? adopted.run : null
  const runId = live?.runId ?? (await startRun(options, taskId))
  onRecord({
    taskId,
    runId,
    pullRequestUrl: live?.pullRequest?.url ?? null,
    answeredKinds: carried,
  })

  const result = await driveRun({ ...options, taskId, runId })
  const answeredKinds = [...new Set([...carried, ...result.answered.map((entry) => entry.kind)])]
  const record = recordOf(result.run, taskId, answeredKinds)
  onRecord(record)
  return { ...result, record, answeredKinds }
}

/**
 * What the deployment still holds for a recorded task: the four states in the doc above, as a
 * union rather than a nullable pair, so a caller cannot read a run off a state that has none.
 */
type Adoption =
  | { kind: 'settled'; taskId: string; run: PublicRun }
  | { kind: 'live'; taskId: string; run: PublicRun }
  | { kind: 'unstarted'; taskId: string }
  | { kind: 'gone' }

async function adopt<P>(options: FileAndDriveOptions<P>, existing: RunRecord): Promise<Adoption> {
  const { client, journal, label } = options
  let run: PublicRun
  try {
    run = await client.tasks.getRun(existing.taskId)
  } catch (error) {
    if (!(error instanceof CatFactoryNotFoundError)) throw error
    // A 404 covers both "no such task" and "a task with no run", which need opposite actions, so
    // the distinction is settled by asking for the task itself. Filing a duplicate merely because
    // a run had not started yet would be the same expensive mistake in a smaller window.
    if (!(await taskExists(client, existing.taskId))) {
      journal.record(
        'milestone',
        `the ledger names task ${existing.taskId} for '${label}' but the board no longer has ` +
          `it; filing again`,
      )
      return { kind: 'gone' }
    }
    journal.record(
      'milestone',
      `re-starting '${label}': task ${existing.taskId} was filed but never ran`,
    )
    return { kind: 'unstarted', taskId: existing.taskId }
  }

  if (isTerminal(run.status)) return { kind: 'settled', taskId: existing.taskId, run }
  journal.say('milestone', `re-attaching to the live run for '${label}': ${describeRun(run)}`)
  return { kind: 'live', taskId: existing.taskId, run }
}

async function taskExists(client: CatFactoryClient, taskId: string): Promise<boolean> {
  try {
    await client.tasks.get(taskId)
    return true
  } catch (error) {
    if (error instanceof CatFactoryNotFoundError) return false
    throw error
  }
}

/**
 * Whether a create that never completed may nonetheless have LANDED, per cause.
 *
 * The create is the one window a client cannot close (README rule 9): the id is recorded on the
 * line after it, so a create the deployment served and whose answer was lost leaves a task no
 * ledger names. What decides which of the two happened is the cause, and the SDK's diagnosis is
 * what supplies it (ADR 0060): a socket that died under the request or a deadline that expired
 * leaves the server free to have acted, while a refused connection, a name that does not resolve, a
 * network with no route to the host, and a handshake or a header the client itself rejected all
 * failed before any origin accepted the request.
 *
 * `unknown` and `aborted` count as landed, and that asymmetry is deliberate: the cost of checking a
 * board that holds nothing is a minute, and the cost of assuming an unread failure created nothing
 * is a second run of the same pipeline against the same default branch. `unknown` is worth that
 * only because `isRequestFailure` has already narrowed it: what reaches here is a transport failure
 * the SDK raised about a call it made and kernel could not classify, not every unrecognised throw
 * on the way to one.
 *
 * An exhaustive `Record`, so a cause added to kernel's vocabulary fails this file to compile and
 * gets a decision rather than defaulting into either half.
 */
const CREATE_MAY_HAVE_LANDED: Record<ConnectionFailureCause, boolean> = {
  reset: true,
  timeout: true,
  aborted: true,
  unknown: true,
  refused: false,
  dns: false,
  unreachable: false,
  'tls-untrusted': false,
  'tls-expired': false,
  'tls-hostname': false,
  'tls-protocol': false,
  'invalid-header': false,
}

/**
 * Whether a thrown value is the SDK's account of a REQUEST, rather than something the suite threw
 * on the way to making one.
 *
 * The gate on the whole classification below, and it replaced a carve-out that keyed on the throw
 * being SYNCHRONOUS. That test looked equivalent and is not: a `createTask` written `async` turns
 * every throw inside it into a rejection, so a brief over the description cap (`briefFields` refuses
 * one before the HTTP call) and a plain `TypeError` from a bug both arrived at the classifier, were
 * read as an unrecognised transport failure, and were reported as a create whose fate is unknown.
 * A suite bug reported as a possibly-filed task sends an operator to search a board for something
 * nothing ever tried to file, and it does it while hiding the bug.
 *
 * The four classes are the ones the transport raises about a call it made: it failed to connect, it
 * ran out of time, it could not read the answer, or the answer was a refusal. Named individually
 * rather than through the `CatFactoryError` base, because that base also covers a fault of the
 * CLIENT (`CatFactoryPaginationError`), which is a bug in a caller's walk and not a create at all.
 */
function isRequestFailure(error: unknown): boolean {
  return (
    error instanceof CatFactoryConnectionError ||
    error instanceof CatFactoryTimeoutError ||
    error instanceof CatFactoryDecodeError ||
    error instanceof CatFactoryApiError
  )
}

/**
 * What the account attached to an in-doubt refusal actually proves, which is not the same fact for
 * each way a create can end without a verdict.
 *
 * Written per kind rather than once, because the one sentence that fitted the transport case
 * ("whether the deployment had been answering this client") is a claim about an origin HISTORY that
 * only the SDK's connection error carries. Under a decode failure it points at a chain that holds
 * no verdict at all, and under a gateway status it describes the wrong party.
 */
function evidenceLine(failure: ProbeFailure): string {
  switch (failure.kind) {
    case 'unanswered':
      return (
        `The account below says whether the deployment had been answering this client before the ` +
        `call that failed, which is the evidence for which of the two happened.`
      )
    case 'answered':
      return (
        `The account below is the intermediary's own ${failure.status}, not the deployment's. It ` +
        `says the deployment could not be reached for an ANSWER, and nothing about whether it had ` +
        `already acted on the request.`
      )
    case 'foreign':
      return (
        `Something answered in a shape no cat-factory backend writes, so there is no verdict below ` +
        `and no history to read one from. What follows is the first of what came back, which ` +
        `normally names whatever stood in for the deployment.`
      )
    default:
      return unknownFailureKind(failure)
  }
}

/**
 * A `ProbeFailure` shape this file has not decided about.
 *
 * `never` keeps {@link evidenceLine} exhaustive at compile time, so a fourth way for a probe to
 * fail cannot be added without saying what it proves about a create. The runtime half is the throw:
 * this refusal exists to tell an operator which of two things happened, and a fall-through onto a
 * sentence written for another kind is the one outcome worse than saying nothing.
 */
function unknownFailureKind(failure: never): never {
  throw new Error(
    `A create failed with a probe verdict this checkout does not classify ` +
      `(${JSON.stringify(failure)}), so it cannot say whether the task was filed.`,
  )
}

/**
 * What a create that did not complete leaves behind, said in the terms the next pass needs.
 *
 * A refusal the DEPLOYMENT stated is not this: it carries a status, a code and a request id, the
 * task was not filed, and re-wrapping it would bury all three. A 502 or a 504 is NOT such a
 * refusal, though it arrives as one: nobody at the deployment wrote it (`isIntermediaryStatus`),
 * and a gateway that gave up waiting for the upstream says nothing about whether the upstream had
 * already written the row. Everything left is one of two facts, and they call for opposite actions,
 * so the pass says which one it is rather than leaving an operator to read a transport chain and
 * guess. An answer that came back unreadable counts as in doubt for the same reason a reset does:
 * the deployment acted and only the reply was lost.
 *
 * Neither refusal carries a `cause`. The account is already IN the message, and `describeFailure`
 * (what prints one) walks the cause chain, so attaching the thrown value would print the SDK's
 * account a second time under the instruction that quoted it: the exact duplication
 * `transportAccount` exists to remove one layer down.
 */
function createFailure(error: unknown, label: string): unknown {
  if (!isRequestFailure(error)) return error
  const failure = describeProbeFailure(error)
  if (failure.kind === 'answered' && !isIntermediaryStatus(failure.status)) return error
  const settled = failure.kind === 'unanswered' && !CREATE_MAY_HAVE_LANDED[failure.cause]
  if (settled) {
    return new OperatorRefusal(
      `Filing '${label}' failed before any origin accepted the request, so nothing was created ` +
        `and a re-run starts from where this pass stopped.\n\n${failure.detail}`,
    )
  }
  return new OperatorRefusal(
    `Filing '${label}' got no usable answer, so whether the task exists is UNKNOWN: the ` +
      `deployment may have filed it and lost the reply on the way back, and an id that never ` +
      `arrives is an id nothing can record.\n\n` +
      `Before re-running, look on the board for a task filed for '${label}'. If one is there, ` +
      `nothing has been spent on it yet (no run was started), so delete it: a re-run finds ` +
      `nothing recorded and files a second one, and two runs against one repository's default ` +
      `branch race on the same branch.\n\n` +
      `${evidenceLine(failure)}\n\n${failure.detail}`,
  )
}

/**
 * Whatever the task body needs read first, resolved BEFORE the create window opens.
 *
 * A failure here propagates as itself: it is a read that failed, not a create, and there is nothing
 * on any board to go looking for.
 */
async function prepare<P>(options: FileAndDriveOptions<P>): Promise<P> {
  // A scenario with nothing to read omits `prepareTask`, and `Prepared` is then `void`: the
  // `undefined` this resolves to IS the only value of that type.
  return options.prepareTask ? await options.prepareTask() : (undefined as P)
}

async function fileTask<P>(options: FileAndDriveOptions<P>): Promise<string> {
  const { createTask, journal, label, onRecord } = options
  const prepared = await prepare(options)
  const { taskId } = await createTask(prepared).catch((error: unknown) => {
    throw createFailure(error, label)
  })
  // Recorded BEFORE anything is started: a process killed between the create and the start would
  // otherwise leave a task on the board that no ledger names and no resume can find.
  onRecord({ taskId, runId: null, pullRequestUrl: null, answeredKinds: [] })
  journal.say('milestone', `filed '${label}' as ${taskId}`)
  return taskId
}

async function startRun<P>(options: FileAndDriveOptions<P>, taskId: string): Promise<string> {
  const { client, journal, pipelineId, label } = options
  // The one call that first learns whether this pass needs a per-user credential: the deployment
  // answers `428` naming the vendor, which is why the seam is a RETRY rather than something
  // resolved up front. A workspace whose models are reached with the deployment's own keys is
  // never asked for one at all.
  const task = await options.credentials(`Starting '${label}'`, () =>
    client.tasks.start(taskId, { pipelineId }),
  )
  if (!task.runId) {
    throw new Error(
      `Starting '${label}' (task ${taskId}) on '${pipelineId}' returned no runId, so there is ` +
        `nothing to follow.`,
    )
  }
  journal.say('milestone', `started '${label}' on ${pipelineId} → run ${task.runId}`)
  return task.runId
}

function recordOf(run: PublicRun, taskId: string, answeredKinds: readonly string[]): RunRecord {
  return {
    taskId,
    runId: run.runId,
    pullRequestUrl: run.pullRequest?.url ?? null,
    answeredKinds,
  }
}
