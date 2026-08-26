import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
