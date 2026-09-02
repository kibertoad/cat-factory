import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import {
  buildProbeArchive,
  PROBE_COMMAND,
  PROBE_IMAGE_TAG,
  PROBE_SENTINEL,
} from './docker-probe-image.js'
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
//   - `unusable`: the container did NOT run. A DECIDED negative, and the only one anything
//                   states to an agent as a prohibition.
//   - `unknown`:  the check could not be carried out: no payload on this machine (the native
//                   host transport, where the harness runs on a developer's laptop), an
//                   architecture nothing maps, `docker load` refusing the archive, a timeout.
//                   Every one of those is a fact about THE CHECK, and reading it as a fact about
//                   the daemon would trade this module's original lie for its mirror image.
// ---------------------------------------------------------------------------

/** What one measurement concluded. See the three answers above; nothing collapses them. */
export type DockerWorkload =
  | { status: 'usable' }
  | { status: 'unusable'; detail: string }
  | { status: 'unknown'; reason: string }

/**
 * The statically linked binary the probe image is built from, overridable for an image variant
 * that ships it elsewhere. Absent is a supported answer, not a failure: under
 * `LOCAL_NATIVE_AGENTS` the harness runs on a developer's machine that never saw this image.
 */
const PAYLOAD_PATH = process.env.HARNESS_DOCKER_PROBE_BINARY?.trim() || '/bin/busybox'

/**
 * The ceiling on each docker invocation the check makes.
 *
 * Sized for a WEDGED daemon, not for a slow one: the payload is a couple of megabytes already on
 * local disk, so a daemon that works answers in about the time it takes to start one container,
 * and a daemon that cannot mount fails immediately. Only a daemon that hangs pays this, and it
 * pays it once per container rather than once per job (see {@link createDockerWorkloadProbe}).
 */
const COMMAND_TIMEOUT_MS = 30_000

/** How much of a failing command's output is kept. It is quoted into an agent's system prompt. */
const DETAIL_CHARS = 300

/** What running one docker command did, kept as raw as the spawn. */
type CommandOutcome =
  | { outcome: 'ran'; code: number; stdout: string; stderr: string }
  | { outcome: 'failed'; reason: string }

/** Run one `docker …` command. Injected so the suite drives every branch with no daemon. */
export type DockerCommandRunner = (args: string[], stdin?: Buffer) => Promise<CommandOutcome>

/** What a measurement needs from the machine, so a test can supply all of it. */
export interface DockerWorkloadDeps {
  /** Read the probe payload. Rejecting (ENOENT) is the supported "this machine has none". */
  readPayload: (path: string) => Promise<Buffer>
  payloadPath: string
  runDocker: DockerCommandRunner
  /** This process's architecture, as `process.arch` spells it. */
  arch: string
}

/** How much of a command's streams is buffered before the rest is dropped. */
const OUTPUT_CAP_CHARS = 64 * 1024

/**
 * The real runner: spawn docker, feed it `stdin` when there is any, and report what happened.
 *
 * Never rejects. Every way a spawn can go wrong is one of the two outcomes, because the caller
 * classifies them differently and an exception would collapse that distinction into whichever
 * `catch` caught it first.
 */
export const spawnDockerCommand: DockerCommandRunner = (args, stdin) =>
  new Promise<CommandOutcome>((resolve) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result: CommandOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        outcome: 'failed',
        reason: `\`docker ${args[0] ?? ''}\` did not answer within ${COMMAND_TIMEOUT_MS / 1000}s`,
      })
    }, COMMAND_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP_CHARS) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_CHARS) stderr += chunk.toString('utf8')
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        outcome: 'failed',
        reason:
          err.code === 'ENOENT'
            ? 'the docker CLI is not on PATH'
            : 'the docker CLI could not be spawned',
      })
    })
    child.on('close', (code) => finish({ outcome: 'ran', code: code ?? -1, stdout, stderr }))
    // A daemon that dies mid-load closes the pipe under us; `close` above already reports that,
    // so the EPIPE here has nothing to add and must not become an unhandled error event.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })

const realDeps: DockerWorkloadDeps = {
  readPayload: (path) => readFile(path),
  payloadPath: PAYLOAD_PATH,
  runDocker: spawnDockerCommand,
  arch: process.arch,
}

/**
 * Carry out one measurement. Pure of caching, so the suite states every branch directly.
 *
 * The disposition of each step is asymmetric ON PURPOSE. Only the RUN produces `unusable`;
 * everything before it produces `unknown`, because everything before it is the platform's own
 * machinery and a bug in it must be able to say "I could not tell" and never "your daemon is
 * broken". The load step in particular is the one this repo wrote itself, and the reported
 * failure lets a single-layer load through anyway, so nothing is lost by being careful there.
 */
export async function measureDockerWorkload(
  deps: DockerWorkloadDeps = realDeps,
): Promise<DockerWorkload> {
  let payload: Buffer
  try {
    payload = await deps.readPayload(deps.payloadPath)
  } catch {
    return {
      status: 'unknown',
      reason: `the platform's own container check needs ${deps.payloadPath}, which this machine does not have`,
    }
  }
  const archive = buildProbeArchive(payload, deps.arch)
  if (!archive) {
    return {
      status: 'unknown',
      reason: `the platform has no container check for the ${deps.arch} architecture`,
    }
  }
  const load = await deps.runDocker(['load'], archive)
  if (load.outcome !== 'ran' || load.code !== 0) {
    return {
      status: 'unknown',
      reason: `the platform could not load its own probe image (${describeOutcome(load)})`,
    }
  }
  const run = await deps.runDocker([
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
  await deps.runDocker(['image', 'rm', '-f', PROBE_IMAGE_TAG])
  if (run.outcome === 'failed') {
    return {
      status: 'unknown',
      reason: `the platform's container check did not run (${run.reason})`,
    }
  }
  if (run.code === 0) {
    if (run.stdout.includes(PROBE_SENTINEL)) return { status: 'usable' }
    // Nothing explains this: the container was reported as having run cleanly and produced none
    // of the output it exists to produce. That is a fact about the check, not about the daemon.
    return {
      status: 'unknown',
      reason: "the platform's probe container exited cleanly without printing its marker",
    }
  }
  return { status: 'unusable', detail: describeOutcome(run) }
}

/** A bounded, scrubbed one-line summary of what a command said, for a prompt or a log field. */
function describeOutcome(outcome: CommandOutcome): string {
  if (outcome.outcome === 'failed') return outcome.reason
  const said = `${outcome.stderr}\n${outcome.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
  const scrubbed = redactSecrets(said)
  const bounded = scrubbed.length > DETAIL_CHARS ? `${scrubbed.slice(0, DETAIL_CHARS)}…` : scrubbed
  return bounded || `docker exited ${outcome.code} without saying why`
}

/**
 * A measurement, plus what the last one concluded without taking another.
 *
 * Callable because every caller wants the verdict; `last()` exists for `GET /health`, which is
 * polled and must not spawn a container per poll to answer a question it does not act on.
 */
export interface DockerWorkloadProbe {
  (): Promise<DockerWorkload>
  last(): DockerWorkload | undefined
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
 * Concurrent callers share one in-flight measurement rather than each starting a container.
 */
export function createDockerWorkloadProbe(
  deps: DockerWorkloadDeps = realDeps,
): DockerWorkloadProbe {
  let latest: DockerWorkload | undefined
  let inFlight: Promise<DockerWorkload> | undefined
  const probe = (async (): Promise<DockerWorkload> => {
    if (latest?.status === 'usable') return latest
    const pending = (inFlight ??= measureDockerWorkload(deps).finally(() => {
      inFlight = undefined
    }))
    latest = await pending
    return latest
  }) as DockerWorkloadProbe
  probe.last = () => latest
  return probe
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
