import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import {
  type ChildLauncher,
  createComposeDependency,
  createHealthProbe,
  createPortReaper,
  formatDowntime,
  type HealthProbe,
  OperatorActionRequiredError,
  runSupervisor,
  type ServiceDependency,
  type SupervisedChild,
  type SuperviseClock,
} from './supervise-runtime.js'
import { resolveSuperviseConfig } from './supervise.js'

/**
 * Unit suite for the EFFECTS half. Everything here is driven through the seams the module already
 * exposes — a fake clock so no test waits in real time, a scripted `HostShell`, a fake launcher —
 * which is what those seams are for: `supervise.it.spec.ts` proves the wiring against a real
 * process, but it cannot cheaply assert the loop's ORDERING (dependencies before restart), the
 * warn-once dedupe, the crash-loop cap, or that every compose shell-out carries its `cwd`.
 */

const config = resolveSuperviseConfig({ pollMs: 1_000, bootGraceMs: 0, failureThreshold: 2 })

/** A clock that advances only when the loop sleeps, so ticks are deterministic and instant. */
function fakeClock(): SuperviseClock & { advanceBy: number[] } {
  let current = 1_000_000
  const advanceBy: number[] = []
  return {
    advanceBy,
    now: () => current,
    sleep(ms) {
      advanceBy.push(ms)
      current += ms
      return Promise.resolve()
    },
  }
}

/** A launcher recording every start, whose children exit only when told to. */
function fakeLauncher(): ChildLauncher & {
  started: number
  killed: number
  exitCurrent: () => void
} {
  let resolveExit: (() => void) | undefined
  const state = {
    started: 0,
    killed: 0,
    exitCurrent: () => resolveExit?.(),
    start(): SupervisedChild {
      state.started += 1
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        resolveExit = () => resolve({ code: 1, signal: null })
      })
      return {
        pid: 1_000 + state.started,
        exited,
        kill: async () => {
          state.killed += 1
          resolveExit?.()
          await Promise.resolve()
        },
      }
    },
  }
  return state
}

/** A probe answering from a scripted list, repeating its last answer once exhausted. */
function scriptedProbe(answers: boolean[]): HealthProbe {
  let i = 0
  return {
    serving: () => Promise.resolve(answers[Math.min(i++, answers.length - 1)] ?? false),
  }
}

function shellFake(routes: Record<string, Partial<ShellResult>>): HostShell & {
  calls: { line: string; cwd?: string }[]
} {
  const calls: { line: string; cwd?: string }[] = []
  return {
    calls,
    run(cmd, args, opts) {
      const line = [cmd, ...args].join(' ')
      calls.push({ line, cwd: opts?.cwd })
      const key = Object.keys(routes).find((prefix) => line.startsWith(prefix))
      const hit = key ? routes[key] : undefined
      return Promise.resolve({
        code: hit?.code ?? 1,
        stdout: hit?.stdout ?? '',
        stderr: hit?.stderr ?? '',
      })
    },
  }
}

describe('runSupervisor — the repair ladder', () => {
  it('runs the dependencies BEFORE relaunching, and only on a repair', async () => {
    // Ordering is the whole point of the ladder: relaunching against a database that is still
    // starting just crashes the child again in `migrate`.
    const order: string[] = []
    const launcher = fakeLauncher()
    const dependency: ServiceDependency = {
      label: 'postgres',
      ensure: () => {
        order.push('ensure')
        return Promise.resolve(true)
      },
    }
    const spyLauncher: ChildLauncher = {
      start: () => {
        order.push('start')
        return launcher.start()
      },
    }

    const outcome = await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([false, false]),
      launcher: spyLauncher,
      dependencies: [dependency],
      log: () => {},
      maxTicks: 2,
    })

    expect(outcome.repairs).toBe(1)
    expect(order).toEqual(['start', 'ensure', 'start'])
  })

  it('reaps the port only AFTER its own child is dead', async () => {
    const order: string[] = []
    const launcher = fakeLauncher()
    await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([false, false]),
      launcher: {
        start: () => {
          const child = launcher.start()
          return {
            ...child,
            kill: async () => {
              order.push('kill')
              await child.kill()
            },
          }
        },
      },
      reaper: {
        reap: () => {
          order.push('reap')
          return Promise.resolve([])
        },
      },
      log: () => {},
      maxTicks: 2,
    })

    // Kill, reap, then (on shutdown) kill + reap again. Never a reap ahead of its kill: reaping by
    // port SIGKILLs a process we were not handed, so it must only ever run once ours is gone.
    expect(order.indexOf('reap')).toBeGreaterThan(order.indexOf('kill'))
  })

  it('does not repair while the stack is serving', async () => {
    const launcher = fakeLauncher()
    const outcome = await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([true]),
      launcher,
      log: () => {},
      maxTicks: 5,
    })
    expect(outcome.repairs).toBe(0)
    expect(launcher.started).toBe(1)
  })
})

describe('runSupervisor — a child that exits', () => {
  it('repairs on the next tick instead of waiting out the failure threshold', async () => {
    const launcher = fakeLauncher()
    const logs: string[] = []
    // The child dies immediately; `failureThreshold` is 2, so a probe-only path would need two
    // ticks. The exited handle is authoritative, so one tick is enough.
    const outcome = await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([false]),
      launcher: {
        start: () => {
          const child = launcher.start()
          launcher.exitCurrent()
          return child
        },
      },
      log: (m) => logs.push(m),
      maxTicks: 1,
    })

    expect(outcome.repairs).toBe(1)
    expect(logs.join('\n')).toContain('the supervised command exited')
  })
})

describe('runSupervisor — the crash-loop cap', () => {
  it('reports and stops once restarts stop producing a serving stack', async () => {
    const launcher = fakeLauncher()
    const logs: string[] = []
    const outcome = await runSupervisor({
      config: resolveSuperviseConfig({
        pollMs: 1_000,
        bootGraceMs: 0,
        failureThreshold: 1,
        maxFailedStarts: 3,
      }),
      clock: fakeClock(),
      probe: scriptedProbe([false]),
      launcher,
      log: (m) => logs.push(m),
      // Far more ticks than the cap: the loop must stop itself rather than run them out.
      maxTicks: 50,
    })

    expect(outcome.gaveUp).toMatch(/failed to serve 4 starts in a row/)
    expect(outcome.repairs).toBe(4)
    expect(launcher.started).toBe(4) // the initial start + 3 restarts, then no more
    expect(logs.join('\n')).toContain('GIVING UP')
  })

  it('a stack that recovers resets the cap, so a long-lived run is never capped', async () => {
    const launcher = fakeLauncher()
    const outcome = await runSupervisor({
      config: resolveSuperviseConfig({
        pollMs: 1_000,
        bootGraceMs: 0,
        failureThreshold: 1,
        maxFailedStarts: 2,
      }),
      clock: fakeClock(),
      // Fails, repairs, serves, fails, repairs, serves … never two consecutive dead starts.
      probe: scriptedProbe([false, true, false, true, false, true, false, true]),
      launcher,
      log: () => {},
      maxTicks: 8,
    })

    expect(outcome.gaveUp).toBeUndefined()
    expect(outcome.repairs).toBeGreaterThan(1)
  })
})

describe('runSupervisor — operator-action dependencies', () => {
  it('prints the guidance ONCE across repeated repairs and reports it as blocked', async () => {
    const logs: string[] = []
    const wedged: ServiceDependency = {
      label: 'k3d cluster "x"',
      ensure: () => Promise.reject(new OperatorActionRequiredError('restart the container engine')),
    }

    const outcome = await runSupervisor({
      config: resolveSuperviseConfig({ pollMs: 1_000, bootGraceMs: 0, failureThreshold: 1 }),
      clock: fakeClock(),
      probe: scriptedProbe([false]),
      launcher: fakeLauncher(),
      dependencies: [wedged],
      log: (m) => logs.push(m),
      maxTicks: 3,
    })

    expect(outcome.blocked).toEqual(['k3d cluster "x"'])
    const warnings = logs.filter((m) => m.includes('NEEDS YOU'))
    expect(warnings).toHaveLength(1)
  })

  it('a blocked dependency does NOT stop the child from being restarted', async () => {
    // A dead cluster breaks environment provisioning, not the whole backend — so the restart
    // still happens.
    const launcher = fakeLauncher()
    await runSupervisor({
      config: resolveSuperviseConfig({ pollMs: 1_000, bootGraceMs: 0, failureThreshold: 1 }),
      clock: fakeClock(),
      probe: scriptedProbe([false]),
      launcher,
      dependencies: [
        { label: 'cluster', ensure: () => Promise.reject(new OperatorActionRequiredError('x')) },
      ],
      log: () => {},
      maxTicks: 1,
    })
    expect(launcher.started).toBe(2)
  })

  it('propagates an unexpected dependency error rather than swallowing it', async () => {
    await expect(
      runSupervisor({
        config: resolveSuperviseConfig({ pollMs: 1_000, bootGraceMs: 0, failureThreshold: 1 }),
        clock: fakeClock(),
        probe: scriptedProbe([false]),
        launcher: fakeLauncher(),
        dependencies: [{ label: 'boom', ensure: () => Promise.reject(new Error('unexpected')) }],
        log: () => {},
        maxTicks: 1,
      }),
    ).rejects.toThrow('unexpected')
  })
})

describe('runSupervisor — shutdown', () => {
  it('kills the child and reaps the port when the stop signal aborts', async () => {
    const launcher = fakeLauncher()
    const stopper = new AbortController()
    let reaped = 0

    // Abort on the first sleep, so the loop stops before it ever probes.
    const clock: SuperviseClock = {
      now: () => 1_000_000,
      sleep: () => {
        stopper.abort()
        return Promise.resolve()
      },
    }

    const outcome = await runSupervisor({
      config,
      clock,
      probe: scriptedProbe([true]),
      launcher,
      reaper: {
        reap: () => {
          reaped += 1
          return Promise.resolve([])
        },
      },
      stopSignal: stopper.signal,
      log: () => {},
    })

    expect(outcome.ticks).toBe(0)
    // The point of moving shutdown into the loop: the child TREE dies, not just the port holder.
    expect(launcher.killed).toBe(1)
    expect(reaped).toBe(1)
  })
})

describe('createComposeDependency', () => {
  it('runs EVERY compose shell-out from the project directory', async () => {
    // The regression: `dir` was accepted and never used, so compose resolved its project file from
    // wherever the supervisor happened to be started and addressed no project at all — reporting a
    // permanently un-ready database instead of restoring it.
    const shell = shellFake({
      'docker compose up': { code: 0 },
      'docker compose ps': { code: 0, stdout: 'abc123\n' },
      'docker inspect': { code: 0, stdout: 'running|healthy' },
    })
    const dependency = createComposeDependency(shell, {
      dir: '/srv/deploy/local',
      service: 'postgres',
    })

    await expect(dependency.ensure()).resolves.toBe(true)
    expect(shell.calls.length).toBeGreaterThan(0)
    for (const call of shell.calls) expect(call.cwd).toBe('/srv/deploy/local')
  })

  it('treats a service with no healthcheck as ready once it is running', async () => {
    const shell = shellFake({
      'docker compose up': { code: 0 },
      'docker compose ps': { code: 0, stdout: 'abc123' },
      'docker inspect': { code: 0, stdout: 'running|none' },
    })
    const dependency = createComposeDependency(shell, { dir: '/x', service: 'postgres' })
    await expect(dependency.ensure()).resolves.toBe(true)
  })

  it('is not ready while the container is still initialising', async () => {
    const shell = shellFake({
      'docker compose up': { code: 0 },
      'docker compose ps': { code: 0, stdout: 'abc123' },
      'docker inspect': { code: 0, stdout: 'running|starting' },
    })
    const dependency = createComposeDependency(shell, {
      dir: '/x',
      service: 'postgres',
      readyTimeoutMs: 30,
      readyPollMs: 5,
    })
    await expect(dependency.ensure()).resolves.toBe(false)
  })

  it('gives up (to retry next cycle) when `up` itself fails', async () => {
    const shell = shellFake({ 'docker compose up': { code: 1, stderr: 'no such file' } })
    const dependency = createComposeDependency(shell, { dir: '/x', service: 'postgres' })
    await expect(dependency.ensure()).resolves.toBe(false)
    expect(shell.calls.some((c) => c.line.startsWith('docker compose ps'))).toBe(false)
  })
})

describe('createPortReaper', () => {
  it('kills the POSIX listener and names what it killed', async () => {
    const logs: string[] = []
    const shell = shellFake({
      lsof: { code: 0, stdout: '4321\n' },
      'ps -p': { code: 0, stdout: 'node --watch src/main.ts\n' },
      kill: { code: 0 },
    })
    const reaper = createPortReaper(shell, 8787, { platform: 'linux', log: (m) => logs.push(m) })

    await expect(reaper.reap()).resolves.toEqual(['4321'])
    expect(shell.calls.some((c) => c.line === 'kill -9 4321')).toBe(true)
    // Disclosure is the mitigation for reaping by port: a surprising kill must be explicable.
    expect(logs.join('\n')).toContain('node --watch src/main.ts')
  })

  it('parses the Windows netstat table and kills the subtree', async () => {
    const netstat = [
      'Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       9001',
      '  TCP    0.0.0.0:5432           0.0.0.0:0              LISTENING       9002',
      '  TCP    [::]:8787              [::]:0                 LISTENING       9001',
    ].join('\r\n')
    const shell = shellFake({
      netstat: { code: 0, stdout: netstat },
      tasklist: { code: 0, stdout: '"node.exe","9001","Console","1","50,000 K"' },
      taskkill: { code: 0 },
    })
    const reaper = createPortReaper(shell, 8787, { platform: 'win32' })

    // Deduped across address families, and the 5432 row is not collateral.
    await expect(reaper.reap()).resolves.toEqual(['9001'])
    expect(shell.calls.some((c) => c.line === 'taskkill /PID 9001 /F /T')).toBe(true)
  })

  it('reports nothing to do when the port is free', async () => {
    const logs: string[] = []
    // `lsof` exits 1 for "no match", which is the ordinary case and must stay quiet.
    const shell = shellFake({ lsof: { code: 1 } })
    const reaper = createPortReaper(shell, 8787, { platform: 'linux', log: (m) => logs.push(m) })

    await expect(reaper.reap()).resolves.toEqual([])
    expect(logs).toEqual([])
  })

  it('says so LOUDLY when lsof is missing, instead of silently reaping nothing', async () => {
    // lsof is absent on many Linux images, which would turn the reaper into a no-op and bring back
    // the EADDRINUSE restart loop it exists to prevent — with no evidence of why.
    const logs: string[] = []
    const shell = shellFake({ lsof: { code: COMMAND_NOT_FOUND } })
    const reaper = createPortReaper(shell, 8787, { platform: 'linux', log: (m) => logs.push(m) })

    await expect(reaper.reap()).resolves.toEqual([])
    expect(logs.join('\n')).toMatch(/lsof is not installed/)
    expect(logs.join('\n')).toMatch(/EADDRINUSE/)
  })
})

describe('createHealthProbe', () => {
  // Real sockets against a real local server on an EPHEMERAL port — no fixed port to collide with,
  // and the two halves of "serving" are only separable against something that actually listens.
  const servers: http.Server[] = []

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
    )
  })

  const listen = async (handler: http.RequestListener): Promise<number> => {
    const server = http.createServer(handler)
    servers.push(server)
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    return (server.address() as AddressInfo).port
  }

  it('is serving when the port listens AND the health path answers 200', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200)
      res.end('{}')
    })
    const probe = createHealthProbe({ port, healthPath: '/health' })
    await expect(probe.serving()).resolves.toBe(true)
  })

  it('is NOT serving when the socket is held but the health check fails', async () => {
    // The second failure mode the two-part probe exists for: a server that booted and kept its
    // listener but lost its DB pool answers 500, and a port-only check would call that healthy.
    const port = await listen((_req, res) => {
      res.writeHead(500)
      res.end()
    })
    const probe = createHealthProbe({ port, healthPath: '/health' })
    await expect(probe.serving()).resolves.toBe(false)
  })

  it('is NOT serving when nothing is bound at all (the parked-watcher shape)', async () => {
    // Bind to learn a free port, then release it, so the probe faces a genuinely closed port.
    const port = await listen((_req, res) => res.end())
    await new Promise<void>((done) => servers.splice(0)[0]?.close(() => done()))
    const probe = createHealthProbe({ port, healthPath: '/health' })
    await expect(probe.serving()).resolves.toBe(false)
  })

  it('reads a non-root health path', async () => {
    const port = await listen((req, res) => {
      res.writeHead(req.url === '/ready' ? 200 : 404)
      res.end()
    })
    await expect(createHealthProbe({ port, healthPath: '/ready' }).serving()).resolves.toBe(true)
    await expect(createHealthProbe({ port, healthPath: '/health' }).serving()).resolves.toBe(false)
  })
})

describe('formatDowntime', () => {
  it('keeps a decimal under a minute, where the interesting outages live', () => {
    expect(formatDowntime(19_300)).toBe('19.3s')
    expect(formatDowntime(900)).toBe('0.9s')
  })

  it('switches to minutes and pads the seconds', () => {
    expect(formatDowntime(72_000)).toBe('1m 12s')
    expect(formatDowntime(65_000)).toBe('1m 05s')
  })
})

describe('runSupervisor — unexplained outages', () => {
  it('reports a self-healed outage with its duration instead of a bland success', async () => {
    const logs: string[] = []
    // Down for one tick, then back — below the failure threshold, so NOTHING here repairs it. That
    // is the shape of a `node --watch` file-change storm: the stack cycles underneath us.
    const outcome = await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([false, true]),
      launcher: fakeLauncher(),
      log: (m) => logs.push(m),
      maxTicks: 2,
    })

    expect(outcome.repairs).toBe(0)
    expect(outcome.unexplainedOutages).toBe(1)
    const output = logs.join('\n')
    expect(output).toContain('unexplained outage #1')
    expect(output).toContain('1.0s down')
    expect(output).toContain('no repair of ours caused it')
  })

  it('explains the likely cause once, not on every recurrence', async () => {
    const logs: string[] = []
    const outcome = await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([false, true, false, true]),
      launcher: fakeLauncher(),
      log: (m) => logs.push(m),
      maxTicks: 4,
    })

    expect(outcome.unexplainedOutages).toBe(2)
    const hints = logs.filter((line) => line.includes('file-change storm'))
    expect(hints).toHaveLength(1)
    expect(logs.join('\n')).toContain('unexplained outage #2')
  })

  it('does NOT count an outage the supervisor itself repaired', async () => {
    // Never serving: the threshold is reached and a repair runs, so this is the supervisor doing its
    // job — the opposite of an unexplained outage, and it must not inflate that counter.
    const outcome = await runSupervisor({
      config,
      clock: fakeClock(),
      probe: scriptedProbe([false]),
      launcher: fakeLauncher(),
      log: () => {},
      maxTicks: 2,
    })

    expect(outcome.repairs).toBeGreaterThan(0)
    expect(outcome.unexplainedOutages).toBe(0)
  })
})
