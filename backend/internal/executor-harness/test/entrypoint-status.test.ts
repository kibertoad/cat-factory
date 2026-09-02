import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  return JSON.parse(readFileSync(statusFile, 'utf8')) as RecordedStatus
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
 * (the Cloudflare-Containers shape the flag was chosen for), and one that has no daemon at all.
 */
type FakeDaemon = 'both' | 'no-iptables' | 'neither'

/** What driving the rootless start produced: the recorded verdict, and how it got there. */
interface RootlessRun {
  status: RecordedStatus
  /** One entry per launch, holding the flags that launch was given. */
  launches: string[]
  stderr: string
}

/**
 * Drive `start_rootless_docker` against stand-ins for `dockerd-rootless.sh` and `docker`.
 *
 * PATH stand-ins rather than an injection seam in the script: what the entrypoint runs is
 * `dockerd-rootless.sh`, resolved on PATH, and a test that had to be given a hook would be
 * asserting a shape the container does not use. The two fakes are the whole sandbox the script
 * can observe, so a case picks the sandbox and reads back the verdict.
 */
function driveRootless(daemon: FakeDaemon): RootlessRun {
  const work = mkdtempSync(join(tmpdir(), 'cf-rootless-'))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const shim = (name: string, body: string): void => {
    const path = join(bin, name)
    writeFileSync(path, `#!/bin/sh\n${body}\n`)
    chmodSync(path, 0o755)
  }
  // The launcher records the flags it was given and, in the arm it agrees to serve, touches the
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
DOCKER_READY_TIMEOUT_SECONDS=5
DOCKER_IPTABLES_READY_TIMEOUT_SECONDS=2
DOCKER_STOP_TIMEOUT_SECONDS=2
DOCKERD_LOG="$WORK/dockerd.log"
DOCKER_HOST="unix://$XDG_RUNTIME_DIR/docker.sock"
${shellFunctions(
  'json_string',
  'write_docker_status',
  'docker_serving',
  'process_alive',
  'await_docker',
  'start_rootless_daemon',
  'stop_rootless_daemon',
  'start_rootless_docker',
)}
start_rootless_docker`,
    {
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      STATUS_FILE: statusFile,
      WORK: work,
      XDG_RUNTIME_DIR: runtime,
      SERVING: join(work, 'serving'),
      LAUNCHES: launches,
    },
  )
  let recorded: string[] = []
  try {
    recorded = readFileSync(launches, 'utf8').split('\n').slice(0, -1)
  } catch {
    recorded = []
  }
  return {
    status: JSON.parse(readFileSync(statusFile, 'utf8')) as RecordedStatus,
    launches: recorded,
    stderr,
  }
}

describe('entrypoint start_rootless_docker', () => {
  it('starts the daemon WITH its own firewall rules, and stops there when that serves', () => {
    // The regression this exists to prevent. `--iptables=false` was applied unconditionally, and
    // the rule it drops is the MASQUERADE for the bridge: nested containers then have no egress
    // at all, so every `docker build` that fetches a dependency fails, slowly (issue #2173). A
    // privileged Docker or Podman host, which is what local mode runs on, can do iptables, and it
    // must never be given the crippled daemon on an assumption about a different sandbox.
    const run = driveRootless('both')
    expect(run.launches).toEqual([''])
    expect(run.status).toMatchObject({ available: true, source: 'rootless', reason: 'serving' })
    expect(run.status.detail).toContain('have egress')
  })

  it('falls back to --iptables=false on the EVIDENCE that the first daemon did not serve', () => {
    // The sandbox the flag was chosen for (Cloudflare Containers), which ends up exactly where it
    // was: a daemon that serves. What it does not end up with is a verdict that hides the cost.
    const run = driveRootless('no-iptables')
    expect(run.launches).toEqual(['', '--iptables=false'])
    expect(run.status.available).toBe(true)
    // A separate `reason` word, not a shrug in the detail: this is the one place the CAUSE of a
    // container having no nested egress exists at all. The harness's own probe measures the
    // consequence from inside a container and can never learn why.
    expect(run.status.reason).toBe('serving-without-nat')
    expect(run.status.detail).toContain('no egress at all')
    expect(run.stderr).toContain('nested containers have NO egress')
  })

  it('gives each arm its own rootlesskit state directory', () => {
    // A killed daemon can leave a lock or a detached network namespace behind, and a replacement
    // that inherited the same state directory would fail for a reason that has nothing to do with
    // why it was started, which is the one failure the fallback must not manufacture.
    const dirs = driveRootless('no-iptables')
      .stderr.split('\n')
      .flatMap((line) => /state-dir=(\S+)/.exec(line)?.[1] ?? [])
    expect(dirs).toHaveLength(2)
    expect(new Set(dirs).size).toBe(2)
  })

  it('records a decided absence, with the log tail, when NEITHER arm serves', () => {
    const run = driveRootless('neither')
    expect(run.launches).toEqual(['', '--iptables=false'])
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
    const pidFile = join(mkdtempSync(join(tmpdir(), 'cf-entrypoint-')), 'child.pid')
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
  })
})
