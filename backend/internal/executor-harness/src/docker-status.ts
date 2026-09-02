import { readFile } from 'node:fs/promises'
import { probeDockerWorkload, type DockerWorkload } from './docker-capability.js'

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
// check runs a real container (docker-capability.ts) rather than asking the daemon about itself.
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
  /** Why, in the entrypoint's own closed vocabulary (`serving`/`failed`/`missing`/…). */
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
 */
export type DockerProbe = () => Promise<DockerWorkload>

/**
 * The default {@link DockerProbe}: the process-wide workload probe, which loads a one-layer
 * image and runs a container from it, memoised per container.
 */
export const probeDockerServing: DockerProbe = () => probeDockerWorkload()

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
  /** Three-valued exactly as {@link DockerStatus.available}, and read the same way. */
  available: boolean | undefined
  /**
   * Set only for a CONFIRMED negative: the sentence to refuse with. Absent means proceed.
   *
   * Two causes reach it and they read differently on purpose. Nothing is answering here, and
   * something is answering here but cannot run a container: an operator sent to restart a daemon
   * that is already up would find nothing wrong with it.
   */
  refusal?: string
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
 * "Not decided" still keeps attempting, untouched. The point of the third value is that NOTHING
 * turns it into a refusal: the entrypoint's bounded wait may still be running, and a workload
 * probe against a daemon that has not finished starting fails for a reason that says nothing
 * about what it will do a second later.
 */
export async function resolveDockerVerdict(
  status: DockerStatus,
  probe: DockerProbe = probeDockerServing,
): Promise<DockerVerdict> {
  if (status.available === undefined) return { available: undefined }
  const workload = await probe()
  if (workload.status === 'usable') return { available: true }
  if (workload.status === 'unusable') {
    return { available: false, refusal: describeDockerUnusable(workload) }
  }
  // The check itself could not be carried out, so it adds nothing and the boot record decides,
  // exactly as it did before this probe existed.
  return status.available
    ? { available: true }
    : { available: false, refusal: describeDockerAbsence(status) }
}
