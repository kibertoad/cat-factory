import { readFile } from 'node:fs/promises'
import {
  type CommandOutcome,
  type DockerCommandRunner,
  spawnDockerCommand,
} from './docker-command.js'
import {
  buildEgressCommand,
  buildProbeArchive,
  EGRESS_DNS_MARKER,
  EGRESS_TCP_MARKER,
  type EgressTarget,
  parseEgressTarget,
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
//
// `usable` then carries a SECOND fact, because running a container and reaching the network from
// inside one are different things and only the first of them was ever measured. A local image
// loads and runs with no network at all, so a daemon whose nested containers are cut off passes
// this check exactly as a working one does: the published image ran its daemon with
// `--iptables=false` and every `docker build` that fetched a dependency was guaranteed to fail,
// while the harness reported `usable` and told each agent that `docker build` works here (issue
// #2174). It is a separate field rather than a fourth status because it answers a separate
// question, with its own three outcomes and its own way of being undeterminable, and because the
// two have different consequences: no egress is a constraint to plan around, where an unusable
// daemon is a prohibition.
// ---------------------------------------------------------------------------

/**
 * What a NESTED container could reach, measured from inside one.
 *
 * Measured there and nowhere else, which is the whole point. The harness container's own network
 * is fine in both cases: it resolves and fetches normally, and the daemon pulls images
 * successfully, so every check one layer out reports a working network over a daemon whose
 * containers have none.
 *
 * `reachable` needs BOTH halves. A route with no DNS is not a network an agent can use: nothing
 * it installs is fetched by address, so `blocked` is the honest verdict and the detail names DNS
 * as the half to fix. The reverse (a name resolved, the configured address refused) is
 * `undetermined` instead of `blocked`, because a resolved name proves a path out exists and the
 * likeliest cause is that this deployment filters the address the check was pointed at.
 */
export type ContainerEgress =
  /** A container opened a TCP connection out AND resolved a public name. */
  | { status: 'reachable' }
  /** It could not get out. `detail` names how far it got, since the two have different fixes. */
  | { status: 'blocked'; detail: string }
  /** The check could not be carried out, or could not be read as evidence about the network. */
  | { status: 'undetermined'; reason: string }

/** What one measurement concluded. See the three answers above; nothing collapses them. */
export type DockerWorkload =
  | { status: 'usable'; egress: ContainerEgress }
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
 * Where the egress check aims, overridable for a deployment whose network permits something else.
 *
 * A raw IPv4 address rather than a name, so the connect answers a question about ROUTING alone:
 * pointing it at a hostname would make every verdict depend on DNS, which is the other half and
 * is measured separately. `1.1.1.1:443` is an anycast address that answers TLS from everywhere
 * and belongs to no API this repo calls; the name is npm's because npm is what the outage
 * actually broke. Neither is validated here (see `parseEgressTarget`), so a rejected setting is
 * reported rather than replaced.
 */
const EGRESS_TARGET = process.env.HARNESS_DOCKER_EGRESS_TARGET?.trim() || '1.1.1.1:443'
const EGRESS_DNS_NAME = process.env.HARNESS_DOCKER_EGRESS_DNS_NAME?.trim() || 'registry.npmjs.org'

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
 * The ceiling on the egress container, which gets its OWN budget rather than a share of the one
 * above.
 *
 * The argument for a single shared budget is that a per-command ceiling multiplies on a WEDGED
 * daemon, and that argument does not reach here: this container is started only after another one
 * has already run to completion, so the daemon is known to work by the time it is spawned. What
 * it does have to allow for is a check that is SUPPOSED to be slow in the failing case, since a
 * blocked route is silent rather than refused and both in-container timeouts have to expire.
 * Taking that out of the workload budget would have starved the step this whole module exists
 * for; leaving it unbounded would hand a wedged network the whole job.
 */
const EGRESS_BUDGET_MS = 20_000

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
  /** Where the egress container aims, as configured. Validated at use, never here. */
  egress: { target: string; dnsName: string }
  logger?: Logger
  archives?: ProbeArchiveMemo
}

const realDeps: DockerWorkloadDeps = {
  readPayload: (path) => readFile(path),
  payloadPath: PAYLOAD_PATH,
  runDocker: spawnDockerCommand,
  arch: process.arch,
  egress: { target: EGRESS_TARGET, dnsName: EGRESS_DNS_NAME },
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
  // A daemon that ran that container has answered the first question, and only then is there a
  // second one worth asking. An `unusable` daemon cannot run the egress container either, and a
  // check that could not be carried out has nothing to measure egress against.
  const verdict = classifyRun(run)
  const measured: DockerWorkload =
    verdict.status === 'usable'
      ? { status: 'usable', egress: await measureEgress(deps, signal) }
      : verdict
  // After both runs, whatever the verdict is: the probe image is the platform's, and an agent
  // that runs `docker images` should not have to wonder whose it is.
  await removeProbeImage(deps)
  return measured
}

/**
 * Run the second container and read what it reached.
 *
 * On the DEFAULT network, deliberately, which is the one thing that separates it from the marker
 * run above (`--network none`). What an agent's own `docker build` and `docker run` get is the
 * bridge, and the bridge is exactly what a daemon started with `--iptables=false` fails to NAT.
 *
 * Never concludes anything about the DAEMON. Every failure here is either evidence about the
 * network or evidence about this check, and the caller has already established that the daemon
 * runs containers.
 */
async function measureEgress(
  deps: DockerWorkloadDeps,
  signal?: AbortSignal,
): Promise<ContainerEgress> {
  const setting = parseEgressTarget(deps.egress.target, deps.egress.dnsName)
  if ('invalid' in setting) return { status: 'undetermined', reason: setting.invalid }
  const run = await deps.runDocker(
    ['run', '--rm', '--pull', 'never', PROBE_IMAGE_TAG, ...buildEgressCommand(setting.target)],
    {
      ...(signal ? { signal } : {}),
      timeoutMs: EGRESS_BUDGET_MS,
      ...(deps.logger ? { logger: deps.logger } : {}),
    },
  )
  return classifyEgress(run, setting.target)
}

/**
 * What the egress container's output proves, over the four combinations its two markers can
 * carry.
 *
 * Read off the STATUS each command printed rather than off the run's own exit code, because the
 * two failures that look alike from outside need opposite answers: a refused connection is
 * evidence about the network, and a 126/127 is busybox saying the image has no such applet, which
 * is evidence about the platform's own payload and may never be reported as a network that is not
 * there.
 */
function classifyEgress(run: CommandOutcome, target: EgressTarget): ContainerEgress {
  const where = `${target.host}:${target.port}`
  if (run.outcome === 'failed') {
    return {
      status: 'undetermined',
      reason: `the platform's egress check did not run (${run.reason})`,
    }
  }
  const tcp = readMarker(run.stdout, EGRESS_TCP_MARKER)
  const dns = readMarker(run.stdout, EGRESS_DNS_MARKER)
  if (tcp === undefined || dns === undefined) {
    return {
      status: 'undetermined',
      reason: `the platform's egress check printed no verdict (${describeOutcome(run)})`,
    }
  }
  if ([tcp, dns].some((code) => code === 126 || code === 127)) {
    return {
      status: 'undetermined',
      reason:
        "the platform's egress check could not run inside its own probe container (the payload " +
        'has no `nc` or `nslookup` applet)',
    }
  }
  if (tcp === 0 && dns === 0) return { status: 'reachable' }
  if (tcp === 0) {
    return {
      status: 'blocked',
      detail: `a container reached ${where} but could not resolve ${target.dnsName}: the route out works and DNS does not`,
    }
  }
  if (dns === 0) {
    // A resolved name proves a path out of the container exists, so the connect failing is far
    // more likely to be about the ADDRESS than about the network. Saying "blocked" here would
    // condemn a working sandbox over a target it happens to filter.
    return {
      status: 'undetermined',
      reason:
        `a container resolved ${target.dnsName} but could not connect to ${where}, so this ` +
        'deployment probably filters that address; point HARNESS_DOCKER_EGRESS_TARGET at one it permits',
    }
  }
  return {
    status: 'blocked',
    detail: `a container could neither connect to ${where} nor resolve ${target.dnsName}: it has no route out at all`,
  }
}

/**
 * The exit status printed after `marker`, or undefined when the container never printed one.
 *
 * The LAST occurrence wins, so a marker that somehow reached the stream twice is read at its
 * final value rather than at whichever came first.
 */
function readMarker(stdout: string, marker: string): number | undefined {
  const status = [...stdout.matchAll(new RegExp(`${marker}(\\d{1,3})`, 'g'))].pop()?.[1]
  return status === undefined ? undefined : Number(status)
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
 *
 * Its own return type, and not {@link DockerWorkload}: what the marker run establishes is a
 * daemon that runs containers, which is the first half of a `usable` verdict and not the whole
 * of one. Naming the intermediate is what stops it being returned as a finished answer with the
 * egress half silently absent.
 */
type RunVerdict = { status: 'usable' } | Exclude<DockerWorkload, { status: 'usable' }>

function classifyRun(run: CommandOutcome): RunVerdict {
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
 * A `usable` verdict whose EGRESS could not be determined is re-measured on the same rule and for
 * the same reason. Whether the bridge is NATed is settled once and for the daemon's life, so a
 * measured `reachable` or `blocked` is kept; a check that timed out or could not be carried out
 * measured nothing, and latching that would leave the container permanently unable to say which
 * of the two it is.
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
    if (latest?.status === 'usable' && latest.egress.status !== 'undetermined') return latest
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
