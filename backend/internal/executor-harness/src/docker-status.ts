import { readFile } from 'node:fs/promises'
import { probeDockerWorkload, type DockerWorkload } from './docker-capability.js'
import { log, type Logger } from './logger.js'

// What this container knows about its own Docker daemon, as recorded by `entrypoint.sh`.
//
// The Tester's local-mode infra stand-up (`docker compose up --wait`) is the only thing in the
// harness that needs a daemon, and for months there was none: the image installed
// `docker-ce-rootless-extras` (the wrappers that START a daemon) but never `docker-ce` (the
// daemon), and the entrypoint backgrounded the start in a subshell where its exit status was
// unobservable. Every local-infra Tester run degraded to a no-infra run, and the only trace was
// a compose error in a prompt note. This module is the answer that was missing: the entrypoint
// probes the daemon once and records the verdict, and everything that would otherwise ASSUME a
// daemon reads it instead.
//
// The recorded verdict describes BOOT, and a container outlives its boot, so nothing refuses on
// it unconfirmed: `resolveDockerVerdict` re-checks it against a live daemon and keeps the record
// for what only the record holds, the cause and the daemon's own log tail. What it records is
// also only that a SOCKET answered, which is a weaker fact than any caller wants, so the live
// check RUNS A CONTAINER (docker-capability.ts) rather than settling for the daemon's word about
// itself. It still reports that weaker fact alongside, since a check that could not be carried
// out is what the boot record has to be read against, and nothing else establishes it.
//
// The three-valued shape is deliberate and is the point (CLAUDE.md, "Degrade loudly"): a daemon
// that FAILED and a daemon nobody asked about are different facts with different correct
// reactions, and collapsing them would either refuse stand-ups that work or silently attempt
// ones that cannot. Only a DECIDED `false` refuses.

/**
 * Where `entrypoint.sh` records its verdict. The two halves of one contract: change this and the
 * `DOCKER_STATUS_FILE` default in `entrypoint.sh` together. `HARNESS_DOCKER_STATUS_FILE`
 * overrides both (the acceptance suite and the unit tests point them at a temp file).
 */
export const DOCKER_STATUS_FILE = '/tmp/harness-docker-status.json'

/** Which daemon the verdict is about. Closed vocabulary, written by `entrypoint.sh`. */
export type DockerSource =
  /** The rootless daemon this container starts for itself. */
  | 'rootless'
  /** A sidecar/external daemon a self-hosted pool wired in via `DOCKER_HOST`. */
  | 'external'
  /** No daemon in this image at all (no `dockerd` on PATH). */
  | 'none'
  /**
   * Nothing recorded a verdict. NOT a failure: the native host-process transport
   * (`LOCAL_NATIVE_AGENTS`) runs this harness with no entrypoint at all, on a developer's
   * machine where Docker usually works fine.
   */
  | 'unreported'

/**
 * The container's Docker verdict.
 *
 * `available` is THREE-valued on purpose. `undefined` means "not decided" — the entrypoint's
 * bounded wait is still running, or nothing recorded anything (native mode) — and a caller must
 * treat it as it behaved before this existed: attempt, and report what happened. `false` is a
 * DECIDED absence and is the only value anything refuses on.
 */
export interface DockerStatus {
  available: boolean | undefined
  source: DockerSource
  /**
   * Why, in the entrypoint's own closed vocabulary (`serving`, `serving-without-nat`, `failed`,
   * `missing`, `unreachable`, `probing`).
   *
   * Reported and never branched on, which is what lets the entrypoint add a word without anything
   * here having to know it. `serving-without-nat` is the one worth knowing about: the rootless
   * daemon would not start with its own firewall rules and runs with `--iptables=false`, so it
   * serves while its NESTED containers have no egress. That is a CAUSE, and the only place one
   * exists; what MEASURES the consequence is the egress half of the workload check
   * (docker-capability.ts), from inside a container, with no way to learn why.
   */
  reason: string
  /** A human detail for the failing cases: the dockerd log tail, or what was unreachable. */
  detail?: string
}

/** The verdict when nothing recorded one (see {@link DockerSource} `unreported`). */
const UNREPORTED: DockerStatus = {
  available: undefined,
  source: 'unreported',
  reason: 'no docker status was recorded for this harness process',
}

const SOURCES: readonly DockerSource[] = ['rootless', 'external', 'none', 'unreported']

/**
 * Read the recorded verdict, or {@link UNREPORTED} when there is none.
 *
 * Defensive by design: the file crosses a shell→Node boundary, so an unreadable, truncated or
 * malformed one answers "not decided" rather than throwing. That is the same disposition as an
 * absent file, and it is the safe one — a parse bug here must not turn into a Tester that refuses
 * to stand its dependencies up.
 */
export async function readDockerStatus(
  path: string = process.env.HARNESS_DOCKER_STATUS_FILE?.trim() || DOCKER_STATUS_FILE,
): Promise<DockerStatus> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return UNREPORTED
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return UNREPORTED
  }
  if (typeof parsed !== 'object' || parsed === null) return UNREPORTED
  const record = parsed as Record<string, unknown>
  const source = SOURCES.includes(record.source as DockerSource)
    ? (record.source as DockerSource)
    : 'unreported'
  const detail = typeof record.detail === 'string' && record.detail ? record.detail : undefined
  return {
    available: typeof record.available === 'boolean' ? record.available : undefined,
    source,
    reason: typeof record.reason === 'string' && record.reason ? record.reason : UNREPORTED.reason,
    ...(detail ? { detail } : {}),
  }
}

/**
 * The sentence a Tester (and the human reading its step) gets instead of a compose error, when
 * the daemon is decidedly absent. It names the cause the agent could not have discovered and the
 * consequence, because the agent's next move differs: with no daemon there is nothing to retry,
 * and the useful run is the one that tests what it can and flags the dependency gap.
 *
 * TOTAL over {@link DockerSource}, deliberately. `unreported` is not a hypothetical arm: the
 * reader above preserves a recorded `available: false` while degrading a source word this build
 * does not know, so an absence whose source is `unreported` is exactly what a status file written
 * by a NEWER entrypoint produces here. A ternary chain ending in the rootless arm answered that
 * case by naming a daemon nobody said anything about: a guess, in the one sentence whose entire
 * job is to tell a human which thing to go and fix. The `never` arm keeps the compile-time half:
 * adding a source without a sentence stops building.
 */
export function describeDockerAbsence(status: DockerStatus): string {
  return status.detail
    ? `${absenceCause(status.source)} (${status.detail})`
    : absenceCause(status.source)
}

function absenceCause(source: DockerSource): string {
  switch (source) {
    case 'none':
      return 'this executor image ships no Docker daemon'
    case 'external':
      return 'the external Docker daemon this container was pointed at is unreachable'
    case 'rootless':
      return 'this container could not start its rootless Docker daemon'
    case 'unreported':
      return 'no Docker daemon answered in this container, and the recorded verdict did not say which one was tried'
    default:
      return unnamedSource(source)
  }
}

function unnamedSource(source: never): string {
  return `no Docker daemon answered in this container (unrecognised source ${JSON.stringify(source)})`
}

/**
 * What a daemon can do RIGHT NOW. Injected so the unit suite can state every answer.
 *
 * It answers with a WORKLOAD rather than with a boolean, and that is the correction this type
 * carries. It used to be `docker version`, which proves the daemon is serving; a stand-up needs
 * a daemon that can materialise an image, and a sandboxed rootless daemon routinely serves while
 * being unable to (issue #2120). Running compose against that one produced a mount error the
 * agent had to interpret, from the one mechanism whose entire job is to say why infra did not
 * come up.
 *
 * The weaker fact did not go away, though: it rides `daemonAnswered` on the `unknown` arm, since
 * the workload check establishes it on its way past and {@link resolveDockerVerdict} still needs
 * it. Takes the job's signal, because this is a live check on the critical path of a run that can
 * be cancelled under it.
 */
export type DockerProbe = (signal?: AbortSignal) => Promise<DockerWorkload>

/**
 * The default {@link DockerProbe}: the process-wide workload probe, which loads a one-layer
 * image and runs a container from it, memoised per container.
 *
 * Named for what it answers. It was `probeDockerServing`, which is the fact this module exists to
 * say is not enough.
 */
export const probeLiveDockerCapability: DockerProbe = (signal) => probeDockerWorkload(signal)

/**
 * The sentence for a daemon that is serving and cannot run anything. It names what was tried,
 * because "docker is unavailable" against a daemon the agent can see answering reads as a bug in
 * the platform rather than as the sandbox limit it is.
 */
export function describeDockerUnusable(workload: { detail: string }): string {
  return `this container's Docker daemon is reachable but cannot run a container (${workload.detail})`
}

/** What a stand-up is entitled to conclude about the daemon at the moment it is about to run. */
export interface DockerVerdict {
  /**
   * Whether a stand-up may PROCEED, three-valued exactly as {@link DockerStatus.available} and
   * read the same way. It is the decision, not a description of the daemon: a daemon that is
   * answering and cannot run a container is `false` here and `daemon: true` below, and a record
   * that reported the first as the second would send an operator to restart a daemon that is
   * already up.
   */
  available: boolean | undefined
  /**
   * Set only for a CONFIRMED negative: the sentence to refuse with. Absent means proceed.
   *
   * Two causes reach it and they read differently on purpose. Nothing is answering here, and
   * something is answering here but cannot run a container: an operator sent to restart a daemon
   * that is already up would find nothing wrong with it.
   */
  refusal?: string
  /**
   * Whether a daemon ANSWERED the live check. Absent when nothing was checked (an undecided
   * record probes nothing) or when nothing answered, so it is never read as a decided `false`.
   */
  daemon?: boolean
  /** What a real container did on it, when one was tried. Absent when nothing was measured. */
  workload?: DockerWorkload
}

/**
 * Resolve what to do now, from what boot recorded plus what the daemon can do today.
 *
 * `entrypoint.sh` probes once, at boot, within a bounded wait, and it probes for a SOCKET. Two
 * things follow, and the branches below are one each.
 *
 * A recorded absence is a HYPOTHESIS. A container outlives its boot: a warm pool serves many jobs
 * from one, and a sidecar daemon that took longer than the wait allows is serving perfectly well
 * by the second job. Refusing off the record alone latches that container into refusing local
 * infra that works, for its whole life, with a stale sentence explaining why. The record is still
 * what supplies the cause and the daemon's own log tail, which no probe can reconstruct.
 *
 * A recorded PRESENCE is a hypothesis too, and that half was missing. `serving` is not `usable`:
 * a rootless daemon in a sandbox answers while unable to mount any image layer, so compose ran
 * and died on a mount error the agent then had to interpret. So the probe is consulted in both
 * directions, and it runs a real container rather than asking the daemon about itself.
 *
 * A check that could not be CARRIED OUT settles nothing, and the cheap fact is what decides
 * there. Falling straight back to the boot record would re-latch the very refusal the paragraph
 * above rules out: the four ways the workload check can come back undeterminable (no payload in
 * this image variant, an architecture it is not built for, a `docker load` the engine refuses, a
 * timeout) have nothing to do with whether a daemon is up, so a warm container whose sidecar
 * arrived late would be denied local infra for the rest of its life over a stale sentence. So a
 * daemon that ANSWERED contradicts a recorded absence exactly as the old `docker version` probe
 * did, and only a check that never reached a daemon at all leaves the record to decide.
 *
 * "Not decided" still keeps attempting, untouched. The point of the third value is that NOTHING
 * turns it into a refusal: the entrypoint's bounded wait may still be running, and a workload
 * probe against a daemon that has not finished starting fails for a reason that says nothing
 * about what it will do a second later.
 */
export async function resolveDockerVerdict(
  status: DockerStatus,
  opts: { probe?: DockerProbe; signal?: AbortSignal; logger?: Logger } = {},
): Promise<DockerVerdict> {
  if (status.available === undefined) return { available: undefined }
  const workload = await askTotally(
    opts.probe ?? probeLiveDockerCapability,
    opts.signal,
    opts.logger,
  )
  if (workload.status === 'usable') return { available: true, daemon: true, workload }
  if (workload.status === 'unusable') {
    return {
      available: false,
      refusal: describeDockerUnusable(workload),
      daemon: true,
      workload,
    }
  }
  if (workload.daemonAnswered) return { available: true, daemon: true, workload }
  return status.available
    ? { available: true, workload }
    : { available: false, refusal: describeDockerAbsence(status), workload }
}

/**
 * Call the probe and answer even if it throws.
 *
 * The default probe is total by construction and says so, but this is the seam an injected one
 * arrives through, and the caller is a stand-up documented as best-effort: a throw here would
 * fail a job over the mechanism whose whole purpose is to make a failure legible. A throw settles
 * nothing about the daemon, so it becomes the same value as any other check that could not be
 * carried out and the boot record decides, exactly as it did before the probe existed.
 */
async function askTotally(
  probe: DockerProbe,
  signal: AbortSignal | undefined,
  logger: Logger | undefined,
): Promise<DockerWorkload> {
  try {
    return await probe(signal)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ;(logger ?? log).warn('docker: the live daemon check threw; falling back to the boot record', {
      error: message,
    })
    return {
      status: 'unknown',
      reason: `the live Docker check could not be carried out (${message})`,
      daemonAnswered: false,
    }
  }
}
