import { readFile } from 'node:fs/promises'
import {
  type CommandOutcome,
  type DockerCommandRunner,
  spawnDockerCommand,
} from './docker-command.js'
import {
  buildProbeArchive,
  payloadArchitecture,
  PROBE_COMMAND,
  PROBE_IMAGE_TAG,
  PROBE_SENTINEL,
} from './docker-probe-image.js'
import { log, type Logger } from './logger.js'
import { redactSecrets } from './redact.js'

// ---------------------------------------------------------------------------
// Whether this machine's Docker daemon can RUN A CONTAINER, as opposed to merely answering.
//
// `docker info` and `docker version` talk to the daemon, and for a long time everything here
// treated an answer from one as proof that `docker build`, `docker run` and `docker compose up`
// work. They are different facts. A rootless daemon nested inside a sandboxed container serves
// perfectly while its snapshotter cannot mount a single image layer, so every one of those
// commands fails with the same EINVAL from `mount(2)` (issue #2120). The harness stated the
// wrong one of the two in every agent's system prompt, in a block that also says not to spend
// turns re-checking it, so three agents in one run each paid to disprove it.
//
// The answer is a real workload: load a one-layer image built in this process
// (docker-probe-image.ts) and run a container from it that has to print a marker. That is the
// smallest thing that exercises the whole path an agent's `docker run` takes, and it needs no
// registry, no network and no second image in the container.
//
// THREE answers, and which failure maps to which is the whole design:
//
//   - `usable`:   a container ran and printed the marker. Nothing else proves this.
//   - `unusable`: the container did NOT run, and the daemon is what refused it. A DECIDED
//                   negative, and the only one anything states to an agent as a prohibition.
//   - `unknown`:  the check could not be carried out: no payload on this machine (the native
//                   host transport, where the harness runs on a developer's laptop), a daemon
//                   whose architecture the payload is not built for, `docker load` refusing the
//                   archive, the probe binary failing to exec, a timeout, a cancelled job.
//                   Every one of those is a fact about THE CHECK, and reading it as a fact about
//                   the daemon would trade this module's original lie for its mirror image.
//
// The `unknown` arm carries {@link DockerWorkload.daemonAnswered} because that distinction is
// load-bearing one level up: `resolveDockerVerdict` needs the cheap fact this check establishes
// on its way past (a daemon is answering RIGHT NOW) to keep a warm container out of a stale boot
// record's refusal, and only the check knows whether it ever got that far.
// ---------------------------------------------------------------------------

/** What one measurement concluded. See the three answers above; nothing collapses them. */
export type DockerWorkload =
  | { status: 'usable' }
  | { status: 'unusable'; detail: string }
  | {
      status: 'unknown'
      reason: string
      /**
       * Whether a daemon ANSWERED before the check ran out of things it could do. A weaker fact
       * than the check exists to establish, and the one a stale boot record must be read against.
       */
      daemonAnswered: boolean
    }

/**
 * The statically linked binary the probe image is built from, overridable for an image variant
 * that ships it elsewhere. Absent is a supported answer, not a failure: under
 * `LOCAL_NATIVE_AGENTS` the harness runs on a developer's machine that never saw this image.
 */
const PAYLOAD_PATH = process.env.HARNESS_DOCKER_PROBE_BINARY?.trim() || '/bin/busybox'

/**
 * The ceiling on ONE WHOLE measurement, shared out across the docker commands it makes: each
 * gets what is left of it, down to {@link MIN_COMMAND_MS}.
 *
 * One budget rather than a per-command ceiling, because a per-command one multiplies: three
 * commands at 30s each is a minute and a half of dead time on a wedged daemon, on the critical
 * path ahead of the clone. Sized for a WEDGED daemon and not for a slow one: the payload is a
 * couple of megabytes already on local disk, so a daemon that works answers in about the time it
 * takes to start one container, and a daemon that cannot mount fails immediately.
 *
 * What it does NOT do is bound the cost per JOB, and the comment that once claimed so was wrong.
 * A POSITIVE verdict is memoised for the container's life; a negative is deliberately
 * re-measured (see {@link createDockerWorkloadProbe}), and two independent sites ask per job (the
 * environment inventory and the compose stand-up), so a serving-but-wedged daemon costs this
 * twice per job. That is the price of not latching a warm container into a stale refusal, which
 * is why the budget is the size it is and why an abandoned job stops paying it at once.
 */
const WORKLOAD_BUDGET_MS = 20_000

/** The floor on one command's share of the budget, so an exhausted budget still gets an answer. */
const MIN_COMMAND_MS = 1_000

/**
 * The ceiling on removing the probe image again.
 *
 * Its own, and deliberately NOT given the caller's abort signal: the image is the platform's, and
 * a cancelled job is the one case where nobody is left to clean up after it. Bounded separately
 * so a wedged daemon cannot turn the cleanup into a second full budget.
 */
const CLEANUP_TIMEOUT_MS = 5_000

/** How much of a failing command's output is kept. It is quoted into an agent's system prompt. */
const DETAIL_CHARS = 300

/**
 * A one-slot memo for the assembled archive.
 *
 * The archive is byte-stable for one `(payload path, architecture)` pair by construction
 * (docker-probe-image.ts pins every timestamp for exactly this reason), and neither half changes
 * within a process. Since a NEGATIVE verdict is re-measured on purpose and two sites ask per job,
 * without this the same two megabytes are re-read and re-sha256'd four times per job for a value
 * that cannot differ. One slot rather than a map: there is only ever one key.
 */
export interface ProbeArchiveMemo {
  read(key: string): Buffer | undefined
  write(key: string, archive: Buffer): void
}

/** Build a {@link ProbeArchiveMemo}. Supplied only by {@link realDeps}, so a test memoises nothing. */
export function oneSlotArchiveMemo(): ProbeArchiveMemo {
  let held: { key: string; archive: Buffer } | undefined
  return {
    read: (key) => (held?.key === key ? held.archive : undefined),
    write: (key, archive) => {
      held = { key, archive }
    },
  }
}

/** What a measurement needs from the machine, so a test can supply all of it. */
export interface DockerWorkloadDeps {
  /** Read the probe payload. Rejecting (ENOENT) is the supported "this machine has none". */
  readPayload: (path: string) => Promise<Buffer>
  payloadPath: string
  runDocker: DockerCommandRunner
  /** This process's architecture, as `process.arch` spells it: the PAYLOAD's, never the daemon's. */
  arch: string
  logger?: Logger
  archives?: ProbeArchiveMemo
}

const realDeps: DockerWorkloadDeps = {
  readPayload: (path) => readFile(path),
  payloadPath: PAYLOAD_PATH,
  runDocker: spawnDockerCommand,
  arch: process.arch,
  archives: oneSlotArchiveMemo(),
}

/**
 * Carry out one measurement. Pure of caching, so the suite states every branch directly.
 *
 * TOTAL: it never rejects, whatever happens inside it. The thing it replaced was total by
 * construction (a `try/catch` around one `execFile`), and it is consulted from a stand-up path
 * documented as best-effort, so a throw here would fail a job over a probe whose whole purpose is
 * to make a failure legible. A throw is also, by definition, the platform's own machinery
 * breaking, which is the `unknown` disposition and never the `unusable` one.
 *
 * That asymmetry is the design. Only the RUN produces `unusable`; everything before it produces
 * `unknown`, because everything before it is the platform's own machinery and a bug in it must be
 * able to say "I could not tell" and never "your daemon is broken". The load step in particular is
 * the one this repo wrote itself.
 */
export async function measureDockerWorkload(
  deps: DockerWorkloadDeps = realDeps,
  signal?: AbortSignal,
): Promise<DockerWorkload> {
  const seen = { daemonAnswered: false }
  try {
    return await measure(deps, seen, signal)
  } catch (err) {
    const cause = describeThrown(err)
    ;(deps.logger ?? log).warn('docker capability: the container check itself fell over', {
      error: cause,
    })
    return undeterminable(
      `the platform's own container check could not be completed (${cause})`,
      seen.daemonAnswered,
    )
  }
}

async function measure(
  deps: DockerWorkloadDeps,
  seen: { daemonAnswered: boolean },
  signal?: AbortSignal,
): Promise<DockerWorkload> {
  const deadline = Date.now() + WORKLOAD_BUDGET_MS
  const share = (): number => Math.max(MIN_COMMAND_MS, deadline - Date.now())
  const command = (args: string[], stdin?: Buffer): Promise<CommandOutcome> =>
    deps.runDocker(args, {
      ...(stdin ? { stdin } : {}),
      ...(signal ? { signal } : {}),
      timeoutMs: share(),
      ...(deps.logger ? { logger: deps.logger } : {}),
    })

  // Ask the DAEMON which architecture it runs, rather than assuming it shares this process's.
  // An external `DOCKER_HOST` is a supported path, and an arm64 harness against an amd64 sidecar
  // (or a remote x86_64 daemon reached from an arm64 laptop) shares nothing with it but a socket:
  // declaring the wrong one in the image config gets the run refused, which would report a
  // perfectly good daemon as one that cannot run containers. It is also the cheapest proof that a
  // daemon is answering at all, which is the fact `resolveDockerVerdict` reads back.
  const asked = await command(['version', '--format', '{{.Server.Arch}}'])
  if (asked.outcome !== 'ran' || asked.code !== 0) {
    return undeterminable(
      `no Docker daemon answered the platform's container check (${describeOutcome(asked)})`,
      false,
    )
  }
  seen.daemonAnswered = true
  const daemonArch = asked.stdout.trim()
  if (!/^[a-z0-9_]+$/.test(daemonArch)) {
    return undeterminable(
      `the Docker daemon did not name an architecture the platform can build an image for (${redactSecrets(daemonArch).slice(0, 40) || 'it answered nothing'})`,
      true,
    )
  }
  const payloadArch = payloadArchitecture(deps.arch)
  if (!payloadArch) {
    return undeterminable(
      `the platform has no container check for the ${deps.arch} architecture`,
      true,
    )
  }
  if (payloadArch !== daemonArch) {
    return undeterminable(
      `the platform's container check is built for ${payloadArch} and this daemon runs ${daemonArch}`,
      true,
    )
  }

  const assembled = await assembleArchive(deps, daemonArch)
  if ('reason' in assembled) return undeterminable(assembled.reason, true)

  const load = await command(['load'], assembled.archive)
  if (load.outcome !== 'ran' || load.code !== 0) {
    return undeterminable(
      `the platform could not load its own probe image (${describeOutcome(load)})`,
      true,
    )
  }

  const run = await command([
    'run',
    '--rm',
    '--pull',
    'never',
    '--network',
    'none',
    PROBE_IMAGE_TAG,
    ...PROBE_COMMAND,
  ])
  // Before the verdict, and whatever the verdict is: the probe image is the platform's, and an
  // agent that runs `docker images` should not have to wonder whose it is.
  await removeProbeImage(deps)
  return classifyRun(run)
}

/**
 * What the container RUN proves. The one step allowed to conclude `unusable`, and even here not
 * every non-zero exit is evidence about the daemon.
 *
 * Docker splits its own failures from the container's by exit code: 125 is `docker run` itself
 * failing, 126 is a command that could not be invoked and 127 one that was not found. The last
 * two are facts about THE PAYLOAD, a binary this platform put in an image it built, and the
 * container had to be created and started to produce them. 125 covers both the daemon refusing to
 * create the container (the verdict this whole module exists for) and the tag not being there to
 * run, which is our own load, so that one is split by what docker SAID.
 */
function classifyRun(run: CommandOutcome): DockerWorkload {
  if (run.outcome === 'failed') {
    return undeterminable(`the platform's container check did not run (${run.reason})`, true)
  }
  if (run.code === 0) {
    if (run.stdout.includes(PROBE_SENTINEL)) return { status: 'usable' }
    // Nothing explains this: the container was reported as having run cleanly and produced none
    // of the output it exists to produce. That is a fact about the check, not about the daemon.
    return undeterminable(
      "the platform's probe container exited cleanly without printing its marker",
      true,
    )
  }
  const ours = platformSideRunFailure(run)
  return ours
    ? undeterminable(`${ours} (${describeOutcome(run)})`, true)
    : { status: 'unusable', detail: describeOutcome(run) }
}

/** Messages that name the PLATFORM's half of a failed run rather than the daemon's. */
const PLATFORM_SIDE_RUN_MESSAGES: readonly { pattern: RegExp; cause: string }[] = [
  {
    pattern: /no such image|unable to find image/i,
    cause: "the platform's probe image was not there to be run",
  },
  {
    pattern: /exec format error/i,
    cause: "the platform's probe binary cannot be executed on this daemon's machine",
  },
]

function platformSideRunFailure(run: {
  code: number
  stdout: string
  stderr: string
}): string | undefined {
  if (run.code === 126 || run.code === 127) {
    return "the platform's probe binary could not be invoked inside the container"
  }
  const said = `${run.stderr}\n${run.stdout}`
  return PLATFORM_SIDE_RUN_MESSAGES.find((m) => m.pattern.test(said))?.cause
}

/**
 * Assemble the archive for the daemon's architecture, reusing the last one built.
 *
 * A read that fails is classified rather than asserted away: `HARNESS_DOCKER_PROBE_BINARY`
 * pointing at a directory, at a path this user may not read, or at a failing mount is a
 * misconfiguration an operator can fix, and "this machine does not have it" states the opposite
 * fact. The sentence goes into an agent's system prompt and into `GET /health`, so a discarded
 * cause is a cause nobody ever sees.
 */
async function assembleArchive(
  deps: DockerWorkloadDeps,
  architecture: string,
): Promise<{ archive: Buffer } | { reason: string }> {
  const key = `${deps.payloadPath}::${architecture}`
  const held = deps.archives?.read(key)
  if (held) return { archive: held }
  let payload: Buffer
  try {
    payload = await deps.readPayload(deps.payloadPath)
  } catch (err) {
    return { reason: describePayloadFailure(err, deps.payloadPath) }
  }
  const archive = buildProbeArchive(payload, architecture)
  deps.archives?.write(key, archive)
  return { archive }
}

function describePayloadFailure(err: unknown, path: string): string {
  const needs = `the platform's own container check needs ${path}`
  switch ((err as NodeJS.ErrnoException).code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return `${needs}, which this machine does not have`
    case 'EACCES':
    case 'EPERM':
      return `${needs}, which it is not permitted to read`
    case 'EISDIR':
      return `${needs} to be a file, and it is a directory`
    default:
      return `${needs}, which could not be read (${describeThrown(err)})`
  }
}

/**
 * Remove the probe image, and SAY SO when that did not work.
 *
 * The one line above it promises an agent will never find a `cat-factory-docker-probe` and wonder
 * whose it is, and the daemon has two ordinary ways to refuse: a `--rm` teardown still in flight
 * holds the image ("image is being used by stopped container"), and a wedged daemon does not
 * answer at all. Discarding the outcome left both silent, so the promise was unverifiable in
 * exactly the states that break it.
 */
async function removeProbeImage(deps: DockerWorkloadDeps): Promise<void> {
  const removed = await deps.runDocker(['image', 'rm', '-f', PROBE_IMAGE_TAG], {
    timeoutMs: CLEANUP_TIMEOUT_MS,
    ...(deps.logger ? { logger: deps.logger } : {}),
  })
  if (removed.outcome === 'ran' && removed.code === 0) return
  ;(deps.logger ?? log).warn('docker capability: the probe image could not be removed', {
    image: PROBE_IMAGE_TAG,
    error: describeOutcome(removed),
  })
}

function undeterminable(reason: string, daemonAnswered: boolean): DockerWorkload {
  return { status: 'unknown', reason, daemonAnswered }
}

/** A bounded, scrubbed one-line summary of what a command said, for a prompt or a log field. */
function describeOutcome(outcome: CommandOutcome): string {
  if (outcome.outcome === 'failed') return outcome.reason
  const said = `${outcome.stderr}\n${outcome.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
  return bounded(said) || `docker exited ${outcome.code} without saying why`
}

/** The one describer for a thrown value here: scrubbed and bounded, like any other detail. */
function describeThrown(err: unknown): string {
  return bounded(err instanceof Error ? err.message : String(err)) || 'it said nothing'
}

function bounded(text: string): string {
  const scrubbed = redactSecrets(text)
  return scrubbed.length > DETAIL_CHARS ? `${scrubbed.slice(0, DETAIL_CHARS)}…` : scrubbed
}

/**
 * A measurement, plus what the last one concluded without taking another.
 *
 * Callable because every caller wants the verdict; `last()` exists for `GET /health`, which is
 * polled and must not spawn a container per poll to answer a question it does not act on.
 */
export interface DockerWorkloadProbe {
  (signal?: AbortSignal): Promise<DockerWorkload>
  last(): DockerWorkload | undefined
}

/** One in-flight measurement and the callers still waiting for it. */
interface Measurement {
  readonly result: Promise<DockerWorkload>
  readonly cancel: AbortController
  waiters: number
}

/**
 * Build a probe that measures at most once per container for a POSITIVE answer.
 *
 * A daemon that has run a container has proved something that does not stop being true, so that
 * verdict is kept and every later job reads it for free. A negative is NOT kept, for the reason
 * `resolveDockerVerdict` gives about the boot record: a container outlives its boot, a warm pool
 * serves many jobs from one, and a daemon that was not ready for the first job must not latch
 * the whole container into saying so. Re-measuring a negative is cheap; a daemon that cannot
 * mount fails at once.
 *
 * Concurrent callers share one in-flight measurement rather than each starting a container, and
 * the measurement is cancelled when the LAST of them has abandoned it. Neither half is optional:
 * one job's abort may not kill a measurement a sibling job is still waiting on (the local native
 * transport serves every concurrent job from one process), and a measurement nobody is waiting
 * for is a container start no job will read, which is what an abandoned run should stop paying
 * for the moment it is abandoned.
 */
export function createDockerWorkloadProbe(
  deps: DockerWorkloadDeps = realDeps,
): DockerWorkloadProbe {
  let latest: DockerWorkload | undefined
  let inFlight: Measurement | undefined
  const begin = (): Measurement => {
    const cancel = new AbortController()
    const measurement: Measurement = {
      cancel,
      waiters: 0,
      result: measureDockerWorkload(deps, cancel.signal).then((verdict) => {
        latest = verdict
        if (inFlight === measurement) inFlight = undefined
        return verdict
      }),
    }
    return measurement
  }
  const probe = (async (signal?: AbortSignal): Promise<DockerWorkload> => {
    if (latest?.status === 'usable') return latest
    const measurement = (inFlight ??= begin())
    measurement.waiters += 1
    const watch = signal ? watchAbandonment(signal) : undefined
    try {
      return watch
        ? await Promise.race([measurement.result, watch.abandoned])
        : await measurement.result
    } finally {
      watch?.dispose()
      measurement.waiters -= 1
      if (measurement.waiters === 0 && inFlight === measurement) measurement.cancel.abort()
    }
  }) as DockerWorkloadProbe
  probe.last = () => latest
  return probe
}

/**
 * A verdict for the caller whose job was cancelled while it waited, and the listener teardown
 * that keeps a long-lived native-transport process from accumulating one per job.
 */
function watchAbandonment(signal: AbortSignal): {
  abandoned: Promise<DockerWorkload>
  dispose: () => void
} {
  let give: () => void = () => {}
  const abandoned = new Promise<DockerWorkload>((resolve) => {
    give = () =>
      resolve(
        undeterminable(
          "the job was cancelled before the platform's container check answered",
          false,
        ),
      )
    if (signal.aborted) give()
    else signal.addEventListener('abort', give, { once: true })
  })
  return { abandoned, dispose: () => signal.removeEventListener('abort', give) }
}

/** The process-wide probe. One per container, which is what makes the positive memo worth having. */
export const probeDockerWorkload: DockerWorkloadProbe = createDockerWorkloadProbe()

/**
 * What `GET /health` reports about the workload check.
 *
 * `unmeasured` is its own word rather than an omitted key or a `null`: this endpoint is polled
 * from boot, so "nothing has needed the daemon yet" is the normal early answer and it must not
 * read as either a broken daemon or a build that cannot report one.
 */
export function reportedDockerWorkload(
  probe: DockerWorkloadProbe = probeDockerWorkload,
): DockerWorkload | { status: 'unmeasured'; reason: string } {
  return (
    probe.last() ?? {
      status: 'unmeasured',
      reason: 'nothing in this container has needed the docker daemon yet',
    }
  )
}
