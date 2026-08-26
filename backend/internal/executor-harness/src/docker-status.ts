import { readFile } from 'node:fs/promises'

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
 * Returns `null` for anything that is not a decided absence, so the caller's branch reads as the
 * refusal it is rather than as a message lookup that might come back empty.
 */
export function dockerUnavailableReason(status: DockerStatus): string | null {
  if (status.available !== false) return null
  const cause =
    status.source === 'none'
      ? 'this executor image ships no Docker daemon'
      : status.source === 'external'
        ? 'the external Docker daemon this container was pointed at is unreachable'
        : 'this container could not start its rootless Docker daemon'
  return status.detail ? `${cause} (${status.detail})` : cause
}
