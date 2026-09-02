import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// `entrypoint.sh`'s side of the Docker verdict, run in a real `/bin/sh`.
//
// The reader (docker-status.ts) is exercised against hand-written status files, which cannot
// catch a WRITER that produces a file no reader can parse — and that failure is silent in the
// worst direction: an unparseable verdict reads as "nothing decided", so the stand-up this whole
// mechanism exists to refuse runs compose against the daemon the container already proved dead.
// The shell functions are therefore driven directly rather than described in a comment.
//
// The container's own boot is not reproducible in a unit test (no rootless daemon, no PID 1), so
// the functions under test are lifted out by name and evaluated on their own. That is exactly as
// much of the script as has behaviour worth pinning; the acceptance suite covers the rest inside
// a real image.

const ENTRYPOINT_PATH = fileURLToPath(new URL('../entrypoint.sh', import.meta.url))
const ENTRYPOINT = readFileSync(ENTRYPOINT_PATH, 'utf8')

/** Lift the named POSIX shell functions out of the entrypoint, in the order given. */
function shellFunctions(...names: string[]): string {
  return names
    .map((name) => {
      const match = new RegExp(`^${name}\\(\\) \\{$[\\s\\S]*?^\\}$`, 'm').exec(ENTRYPOINT)
      if (!match) throw new Error(`${ENTRYPOINT_PATH} has no shell function \`${name}()\` to lift`)
      return match[0]
    })
    .join('\n')
}

/** Both streams, because what this script says on stderr when it degrades is part of the contract. */
function runSh(
  script: string,
  env: Record<string, string> = {},
): { stdout: string; stderr: string } {
  const result = spawnSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  })
  if (result.status !== 0) {
    throw new Error(`/bin/sh exited ${String(result.status)}: ${result.stderr}`)
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

interface RecordedStatus {
  available: boolean | null
  source: string
  reason: string
  detail: string
}

/** Run `write_docker_status` with `detail` and read back what the harness would parse. */
function recordDetail(detail: string): RecordedStatus {
  const dir = mkdtempSync(join(tmpdir(), 'cf-entrypoint-'))
  const statusFile = join(dir, 'status.json')
  runSh(
    `set -eu
DOCKER_STATUS_FILE="$STATUS_FILE"
${shellFunctions('json_string', 'write_docker_status')}
write_docker_status false rootless failed "$DETAIL"`,
    { STATUS_FILE: statusFile, DETAIL: detail },
  )
  // No `.tmp` may survive: the harness reads this file concurrently, so the write lands by rename.
  expect(readdirSync(dir)).toEqual(['status.json'])
  const status = JSON.parse(readFileSync(statusFile, 'utf8')) as RecordedStatus
  rmSync(dir, { recursive: true, force: true })
  return status
}

describe('entrypoint write_docker_status', () => {
  it('records a detail carrying quotes and backslashes as parseable JSON', () => {
    const status = recordDetail('failed to load "config" from C:\\docker\\daemon.json')
    expect(status.detail).toBe('failed to load "config" from C:\\docker\\daemon.json')
    expect(status.available).toBe(false)
    expect(status.source).toBe('rootless')
  })

  it('bounds the detail without splitting the escape sequence at the cut', () => {
    // The regression. Truncating AFTER escaping cuts the `\"` pair in half and leaves a trailing
    // lone backslash, which makes the whole file unparseable — and an unparseable file reads as
    // NO verdict, which is the one answer that lets the refusal be skipped entirely.
    const detail = `${'a'.repeat(1999)}"tail that does not fit`
    const status = recordDetail(detail)
    expect(status.detail).toBe(`${'a'.repeat(1999)}"`)
  })

  it('drops the control bytes a daemon log tail carries', () => {
    // JSON forbids unescaped C0 characters, and dockerd logs are not guaranteed to be free of
    // them: one ANSI colour sequence in the tail would otherwise cost the verdict its file.
    const status = recordDetail('\u001b[31mrootlesskit:\u001b[0m failed\u0007 to setup network')
    expect(status.detail).toBe('[31mrootlesskit:[0m failed to setup network')
  })

  it('flattens the newlines of a multi-line log tail into one line', () => {
    expect(recordDetail('first line\nsecond\tline\r\n').detail).toBe('first line second line  ')
  })

  it('does not take the boot down when the verdict cannot be written', () => {
    // `write_docker_status` runs in the FOREGROUND, before the harness is exec'd, and the script
    // runs under `set -e`. An unwritable `HARNESS_DOCKER_STATUS_FILE` must cost the verdict and
    // nothing else: the contract at the top of the file is that no part of this blocks the boot.
    const { stdout, stderr } = runSh(
      `set -eu
DOCKER_STATUS_FILE=/proc/self/no/such/directory/status.json
${shellFunctions('json_string', 'write_docker_status')}
write_docker_status false none missing 'no daemon here'
echo booted`,
    )
    expect(stdout).toContain('booted')
    // Loudly, though: an unrecorded verdict reads downstream as "nothing decided", so the one
    // place that knows why must say so rather than leaving the silence to be interpreted.
    expect(stderr).toContain('could not record the docker verdict')
  })
})

/**
 * Which daemon a stand-in `dockerd-rootless.sh` agrees to be, so a case states only the sandbox it
 * is about: one that manages its own firewall rules, one that can only run with `--iptables=false`
 * (the Cloudflare-Containers shape the flag was chosen for), one that has no daemon at all, and
 * one that neither serves nor exits, which is the shape a CLOCK cannot tell from a slow start.
 */
type FakeDaemon = 'both' | 'no-iptables' | 'neither' | 'hangs'

/** What driving the rootless start produced: the recorded verdict, and how it got there. */
interface RootlessRun {
  status: RecordedStatus
  /** One entry per launch, holding the whole argv that launch was given. */
  launches: string[]
  /**
   * The daemon log both arms write to, which is where a launcher's own output lands: the
   * entrypoint redirects each daemon's streams into it, so nothing a launcher prints reaches
   * this process's stderr except by way of the failure branch quoting the tail.
   */
  log: string
  stderr: string
}

/**
 * Drive `start_rootless_docker` against stand-ins for `dockerd-rootless.sh` and `docker`.
 *
 * PATH stand-ins rather than an injection seam in the script: what the entrypoint runs is
 * `dockerd-rootless.sh`, resolved on PATH, and a test that had to be given a hook would be
 * asserting a shape the container does not use. The two fakes are the whole sandbox the script
 * can observe, so a case picks the sandbox and reads back the verdict.
 *
 * `readySeconds` is a parameter because ONE case pays the readiness budget in full: a first arm
 * that neither serves nor exits is the only shape the wait cannot end early on, so it spends the
 * whole thing in `sleep 1` and would otherwise run past vitest's own per-test ceiling. Every other
 * case ends on the socket or on the dead pid within a second of starting.
 */
function driveRootless(daemon: FakeDaemon, readySeconds = 5): RootlessRun {
  const work = mkdtempSync(join(tmpdir(), 'cf-rootless-'))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const shim = (name: string, body: string): void => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  // The launcher records the argv it was given and, in the arm it agrees to serve, touches the
  // flag the `docker` stand-in answers on. `exec sleep` so the pid the script watches is a live
  // process, which is what makes the readiness wait real rather than a formality.
  shim(
    'dockerd-rootless.sh',
    [
      'echo "$*" >>"$LAUNCHES"',
      'echo "state-dir=$DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR args=$*"',
      `case "${daemon}" in`,
      '  both) : >"$SERVING"; exec sleep 300 ;;',
      '  no-iptables)',
      '    case "$*" in *--iptables=false*) : >"$SERVING"; exec sleep 300 ;; esac',
      '    echo "failed to start daemon: iptables not found" >&2; exit 1 ;;',
      '  neither) echo "failed to start daemon: no user namespaces" >&2; exit 1 ;;',
      '  hangs) exec sleep 300 ;;',
      'esac',
    ].join('\n'),
  )
  shim('docker', '[ -f "$SERVING" ] || exit 1\necho 29.7.2')

  const runtime = join(work, 'run')
  mkdirSync(runtime)
  const statusFile = join(work, 'status.json')
  const launches = join(work, 'launches')
  const { stderr } = runSh(
    `set -eu
DOCKER_STATUS_FILE="$STATUS_FILE"
DOCKER_READY_TIMEOUT_SECONDS=$READY_SECONDS
DOCKER_FALLBACK_MIN_SECONDS=2
DOCKER_STOP_TIMEOUT_SECONDS=2
DOCKERD_LOG="$WORK/dockerd.log"
DOCKER_DATA_ROOT_BASE="$WORK/data"
DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
${shellFunctions(
  'json_string',
  'write_docker_status',
  'docker_serving',
  'process_alive',
  'await_docker',
  'start_rootless_daemon',
  'stop_rootless_daemon',
  'rootless_log_tail',
  'start_rootless_docker',
)}
start_rootless_docker
# Whatever arm ended up serving is still sleeping: nothing stops a daemon that WORKED, so
# without this each case leaves a stray process alive for five minutes on the CI worker.
kill "$ROOTLESS_DAEMON_PID" 2>/dev/null || true`,
    {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      STATUS_FILE: statusFile,
      READY_SECONDS: String(readySeconds),
      WORK: work,
      XDG_RUNTIME_DIR: runtime,
      SERVING: join(work, 'serving'),
      LAUNCHES: launches,
    },
  )
  const readOrEmpty = (path: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }
  const run = {
    status: JSON.parse(readFileSync(statusFile, 'utf8')) as RecordedStatus,
    launches: readOrEmpty(launches).split('\n').slice(0, -1),
    log: readOrEmpty(join(work, 'dockerd.log')),
    stderr,
  }
  rmSync(work, { recursive: true, force: true })
  return run
}

/** The `--iptables=false` arm's argv, or undefined when the fallback was never reached. */
function fallbackLaunch(run: RootlessRun): string | undefined {
  return run.launches.find((argv) => argv.includes('--iptables=false'))
}

/** What one launch was told to keep its exclusive state in: its data root and its pid file. */
function exclusiveState(argv: string): string[] {
  return [/--data-root (\S+)/, /--pidfile (\S+)/].map((pattern) => pattern.exec(argv)?.[1] ?? '')
}

describe('entrypoint start_rootless_docker', () => {
  it('starts the daemon WITH its own firewall rules, and stops there when that serves', () => {
    // The regression this exists to prevent. `--iptables=false` was applied unconditionally, and
    // the rule it drops is the MASQUERADE for the bridge: nested containers then have no egress
    // at all, so every `docker build` that fetches a dependency fails, slowly (issue #2173). A
    // privileged Docker or Podman host, which is what local mode runs on, can do iptables, and it
    // must never be given the crippled daemon on an assumption about a different sandbox.
    const run = driveRootless('both')
    expect(run.launches).toHaveLength(1)
    expect(fallbackLaunch(run)).toBeUndefined()
    expect(run.status).toMatchObject({ available: true, source: 'rootless', reason: 'serving' })
    expect(run.status.detail).toContain('have egress')
  })

  it('falls back to --iptables=false when the first daemon EXITS without serving', () => {
    // The sandbox the flag was chosen for (Cloudflare Containers), which ends up exactly where it
    // was: a daemon that serves. What it does not end up with is a verdict that hides the cost.
    const run = driveRootless('no-iptables')
    expect(run.launches).toHaveLength(2)
    expect(fallbackLaunch(run)).toBeDefined()
    expect(run.status.available).toBe(true)
    // A separate `reason` word, not a shrug in the detail: this is the one place the CAUSE of a
    // container having no nested egress exists at all. The harness's own probe measures the
    // consequence from inside a container and can never learn why.
    expect(run.status.reason).toBe('serving-without-nat')
    expect(run.status.detail).toContain('no egress at all')
    expect(run.stderr).toContain('nested containers have NO egress')
  })

  it('claims only what it observed about the first arm, never that iptables is unavailable', () => {
    // The detail is quoted at an operator, and "iptables is unavailable here" is a CAUSE nothing
    // in this script measured: all it has is a daemon that exited. Sending someone to fix a
    // firewall restriction that may not exist is the same class of confident wrong answer the
    // egress probe was added to stop making.
    const run = driveRootless('no-iptables')
    expect(run.status.detail).toContain('exited without serving')
    expect(run.status.detail).not.toContain('iptables is unavailable')
  })

  it("quotes the first arm's own log tail when it announces the fallback", () => {
    // The one place the real cause exists is the daemon's log, and it is written to a file inside
    // the container that nobody reads. Announcing the fallback without it leaves an operator with
    // a message that names the switch and not the reason for it.
    expect(driveRootless('no-iptables').stderr).toContain('iptables not found')
  })

  it('does NOT swap daemons on a first arm that is merely slow', () => {
    // A clock says nothing about firewall rules. A sandbox that genuinely forbids them makes
    // dockerd EXIT at once, so a first arm still running at the ceiling is a cold start as often
    // as a wedged one, and swapping there costs a capable daemon its NAT for the container's
    // whole life, on a guess. It is recorded as undecided and LEFT RUNNING instead, so a daemon
    // that comes up late is still found by `resolveDockerVerdict`'s live re-probe.
    const run = driveRootless('hangs', 2)
    expect(run.launches).toHaveLength(1)
    expect(fallbackLaunch(run)).toBeUndefined()
    // Its own reason word: a daemon still starting and two daemons that both exited are opposite
    // situations, and this is the one absence that routinely stops being true.
    expect(run.status).toMatchObject({
      available: false,
      source: 'rootless',
      reason: 'still-starting',
    })
    expect(run.status.detail).toContain('is still running')
    expect(run.stderr).toContain('is still running')
  })

  it('gives each arm its own rootlesskit state directory, data root and pid file', () => {
    // An abandoned daemon can leave a lock, a detached network namespace, a flock on its data
    // root or a live pid file behind, and a replacement that inherited any of them fails for a
    // reason that has nothing to do with why it was started. That is the worst outcome available
    // here: BOTH arms record `failed` and the container ends up with no daemon at all, where
    // before any of this it had a working crippled one.
    const run = driveRootless('no-iptables')
    const dirs = run.log.split('\n').flatMap((line) => /state-dir=(\S+)/.exec(line)?.[1] ?? [])
    expect(dirs).toHaveLength(2)
    expect(new Set(dirs).size).toBe(2)

    const state = run.launches.map(exclusiveState)
    expect(state).toHaveLength(2)
    expect(state.flat().filter(Boolean)).toHaveLength(4)
    expect(new Set(state.flat()).size).toBe(4)
  })

  it('records a decided absence, with the log tail, when NEITHER arm serves', () => {
    const run = driveRootless('neither')
    expect(run.launches).toHaveLength(2)
    expect(fallbackLaunch(run)).toBeDefined()
    expect(run.status).toMatchObject({ available: false, source: 'rootless', reason: 'failed' })
    // Both arms wrote to one log and the tail is the LAST one's, which is the failure being
    // explained; a human reading the whole file still sees why the first was abandoned.
    expect(run.status.detail).toContain('--iptables=false')
    expect(run.status.detail).toContain('no user namespaces')
  })
})

describe('entrypoint process_alive', () => {
  it('reports a running process as alive', () => {
    const { stdout } = runSh(
      `set -eu
${shellFunctions('process_alive')}
sleep 5 &
child=$!
if process_alive "$child"; then echo alive; else echo dead; fi
kill "$child" 2>/dev/null || true`,
    )
    expect(stdout.trim()).toBe('alive')
  })

  it('reports an unreaped dead process as dead, where `kill -0` cannot', () => {
    // The container's shape exactly: the daemon is a background child of a shell that then
    // `exec`s node in its place, and node as PID 1 reaps nothing. The dead daemon lingers as a
    // ZOMBIE, which `kill -0` reports as present — so on `kill -0` the readiness wait's early
    // exit never fires, every packaging failure costs the full 60s, and jobs dispatched inside
    // that window read the verdict as undecided and attempt compose anyway.
    const pidDir = mkdtempSync(join(tmpdir(), 'cf-entrypoint-'))
    const pidFile = join(pidDir, 'child.pid')
    const { stdout } = runSh(
      `set -eu
${shellFunctions('process_alive')}
sh -c 'sleep 0 & echo $! >"$PID_FILE"; exec sleep 5' &
supervisor=$!
sleep 1
child="$(cat "$PID_FILE")"
if kill -0 "$child" 2>/dev/null; then echo "signal:present"; else echo "signal:absent"; fi
if process_alive "$child"; then echo "verdict:alive"; else echo "verdict:dead"; fi
kill "$supervisor" 2>/dev/null || true`,
      { PID_FILE: pidFile },
    )
    expect(stdout).toContain('signal:present')
    expect(stdout).toContain('verdict:dead')
    rmSync(pidDir, { recursive: true, force: true })
  })
})
