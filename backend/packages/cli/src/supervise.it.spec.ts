import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * Integration suite for `cat-factory supervise`, driving the REAL built CLI as its own process
 * against a real child.
 *
 * This has to be out-of-process to be worth anything. The bug it exists to prevent was that the
 * poll timer was `unref`'d: while the child lived, its process handle kept the event loop open, so
 * everything looked fine — but the instant the child was killed that reference vanished, the
 * unref'd timer could not hold the loop, and Node exited **0**. A watchdog that died with its
 * patient, silently, reporting success. In-process (where vitest itself keeps the loop alive) that
 * failure is invisible, which is exactly why the unit tests missed it and a live run caught it.
 *
 * Self-skips when the CLI has not been built, mirroring the `K8S_IT_*` / `DATABASE_URL` self-skip
 * pattern used elsewhere in the repo.
 */

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

/**
 * The supervisor has to be told a FIXED port (it probes one), but hard-coding it would make the
 * suite collide with whatever else happens to be on that port — including a second shard of itself.
 * So claim a free one from the OS first and release it: a small race window, versus a guaranteed
 * clash. The port must also be free at the moment the toy server binds, which is why the reservation
 * is released rather than held.
 */
async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((closed) => server.close(() => closed()))
  return port
}

const toyServer = (port: number): string => `
import http from 'node:http'
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('{"status":"ok"}'); return }
  res.writeHead(404); res.end()
}).listen(${port}, '127.0.0.1', () => console.log('toy-server-pid=' + process.pid))
`

function statusOf(url: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1_000 }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.once('error', () => resolve(0))
    req.once('timeout', () => {
      req.destroy()
      resolve(0)
    })
  })
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until `predicate` holds, or give up after `timeoutMs`. Returns whether it held. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await delay(250)
  }
  return false
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!existsSync(BIN))('cat-factory supervise (integration)', () => {
  let supervisor: ReturnType<typeof spawn> | undefined

  afterEach(async () => {
    if (supervisor?.pid !== undefined && alive(supervisor.pid)) {
      // `/T` on Windows, process group elsewhere: the toy server must not outlive the test.
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(supervisor.pid), '/F', '/T'], { stdio: 'ignore' }).unref()
      } else {
        try {
          process.kill(-supervisor.pid, 'SIGKILL')
        } catch {
          // silent-catch-ok: teardown of an already-dead process group is the desired end state.
        }
      }
      await delay(500)
    }
    supervisor = undefined
  })

  it('outlives its child and restarts it', async () => {
    const port = await reservePort()
    const health = `http://127.0.0.1:${port}/health`
    const dir = mkdtempSync(join(tmpdir(), 'cf-supervise-'))
    const script = join(dir, 'toy-server.mjs')
    writeFileSync(script, toyServer(port))

    supervisor = spawn(
      process.execPath,
      [
        BIN,
        'supervise',
        '--port',
        String(port),
        '--poll',
        '1',
        '--boot-grace',
        '2',
        '--failures',
        '2',
        '--',
        // Two separate tokens: the CLI re-quotes each as needed. `process.execPath` normally lives
        // under "C:\Program Files\…", so this also covers quoting a path that contains a space.
        process.execPath,
        script,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' },
    )

    let output = ''
    supervisor.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })

    const bootedUp = await waitFor(async () => (await statusOf(health)) === 200, 30_000)
    expect(bootedUp, `supervised child never served. Output:\n${output}`).toBe(true)

    const firstPid = Number(/toy-server-pid=(\d+)/.exec(output)?.[1])
    expect(Number.isInteger(firstPid)).toBe(true)

    // Kill the CHILD only. The supervisor keeps its own PID, so this is the exact moment the
    // unref'd-timer bug made it exit 0.
    process.kill(firstPid, 'SIGKILL')
    const wentDown = await waitFor(async () => (await statusOf(health)) !== 200, 15_000)
    expect(wentDown, `the child never actually went down. Output:\n${output}`).toBe(true)

    const cameBack = await waitFor(async () => (await statusOf(health)) === 200, 60_000)
    expect(cameBack, `supervisor did not restart the child. Output:\n${output}`).toBe(true)

    // The supervisor itself must still be running — the whole point.
    expect(alive(supervisor.pid as number)).toBe(true)
    expect(supervisor.exitCode).toBeNull()

    // And it must be a genuinely NEW process, not a stale reading of the old one.
    const pids = [...output.matchAll(/toy-server-pid=(\d+)/g)].map((m) => Number(m[1]))
    expect(pids.length).toBeGreaterThanOrEqual(2)
    expect(pids[pids.length - 1]).not.toBe(firstPid)
    expect(output).toMatch(/repair #1/)

    // Shut down cleanly and read the summary. This is the ONLY reader of the run's counters, and
    // the only place they stay legible: on a supervisor left up for days, the line that reported
    // each event scrolled away long ago, and an outage nothing repaired leaves no other trace at
    // all. It has to be asserted out-of-process, because the counters only reach it through a
    // real signal breaking the loop out of its poll interval.
    process.kill(supervisor.pid as number, 'SIGINT')
    const exited = await waitFor(() => Promise.resolve(supervisor?.exitCode !== null), 30_000)
    expect(exited, `supervisor did not exit on SIGINT. Output:\n${output}`).toBe(true)
    // Exit 0: it stopped because it was asked to, not because the command was broken.
    expect(supervisor.exitCode).toBe(0)
    expect(output, `no shutdown summary. Output:\n${output}`).toMatch(
      /stopped after \d+ probe\(s\): \d+ repair\(s\), \d+ unexplained outage\(s\)/,
    )
  })
})
