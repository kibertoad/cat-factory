import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withSalvagedWork } from '../src/coding-agent.js'
import { salvageUntrackedWork } from '../src/salvage.js'
import { headCommit } from '../src/git.js'
import type { Logger } from '../src/logger.js'

const exec = promisify(execFile)

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
}

// The rescue of an ABORTED run: the run's own lifetime is over by the time this fires, which is
// what makes every mechanic here easy to get subtly, silently wrong.
describe('withSalvagedWork (rescuing an aborted run)', () => {
  let dir: string
  const git = (...args: string[]): Promise<unknown> => exec('git', args, { cwd: dir })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rescue-test-'))
    await git('init', '-b', 'main')
    await git('config', 'user.email', 'test@example.com')
    await git('config', 'user.name', 'Test')
    await writeFile(join(dir, 'README.md'), '# base\n', 'utf8')
    await git('add', '-A')
    await git('commit', '-m', 'base')
    // What the killed agent built through `bash` heredocs and never committed.
    await writeFile(join(dir, 'src.ts'), 'export const x = 1\n', 'utf8')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an ALREADY-ABORTED signal makes the salvage a no-op — which is why the rescue mints its own', async () => {
    // The trap this whole design turns on, pinned here so nobody re-threads the run's signal
    // through the rescue: `execFile` rejects on an aborted signal before it spawns anything, so a
    // rescue carrying the watchdog's signal cannot run one git command, and the paths that need
    // rescuing most (watchdog, eviction) are exactly the ones where it is already aborted.
    const base = await headCommit(dir)
    const dead = new AbortController()
    dead.abort()
    // It does not even reach the commit: the LISTING is the first git call, so the salvage throws
    // outright. `withSalvagedWork` swallows a throwing salvage on purpose (the reason the run died
    // outranks the reason its rescue did), so on that signal the run reported nothing at all about
    // the work it had just lost.
    await expect(
      salvageUntrackedWork({
        dir,
        occasion: { kind: 'aborted', cause: 'inactivity timeout' },
        logger: silentLogger,
        signal: dead.signal,
      }),
    ).rejects.toThrow()
    expect(await headCommit(dir)).toBe(base)
  })

  it('commits and pushes the work on a live signal of its own', async () => {
    const base = await headCommit(dir)
    const pushSignals: (AbortSignal | undefined)[] = []
    const rethrown = await withSalvagedWork(new Error('inactivity timeout'), {
      dir,
      logger: silentLogger,
      pushWorkOnce: async (override) => {
        pushSignals.push(override)
      },
      inFlightPush: () => null,
    })

    expect(await headCommit(dir)).not.toBe(base)
    expect(pushSignals).toHaveLength(1)
    expect(pushSignals[0]?.aborted).toBe(false)
    expect((rethrown as Error).message).toMatch(/inactivity timeout/)
    expect((rethrown as Error).message).toMatch(/salvaged into commit/)
    expect((rethrown as Error).message).not.toMatch(/could NOT be pushed/)
  })

  it('drains the checkpoint push already in flight BEFORE it salvages and pushes', async () => {
    // `pushWorkOnce` coalesces: a rescue that started behind a running checkpoint would be handed
    // that push, which was made before the salvage commit existed. The report would then name a
    // commit the remote never received.
    const order: string[] = []
    let release: () => void = () => {}
    const checkpoint = new Promise<void>((resolve) => {
      release = () => {
        order.push('checkpoint-settled')
        resolve()
      }
    })
    let headAtPush: string | undefined
    const rescue = withSalvagedWork(new Error('max duration exceeded'), {
      dir,
      logger: silentLogger,
      pushWorkOnce: async () => {
        order.push('rescue-push')
        headAtPush = await headCommit(dir)
      },
      inFlightPush: () => checkpoint,
    })
    // The rescue is parked on the drain; nothing has been committed or pushed yet.
    await Promise.resolve()
    expect(order).toEqual([])
    release()
    await rescue

    expect(order).toEqual(['checkpoint-settled', 'rescue-push'])
    // And the push it made was of the tree WITH the salvage commit on it.
    expect(headAtPush).toBe(await headCommit(dir))
  })

  it('does not let a failed checkpoint push stop the rescue', async () => {
    const rethrown = await withSalvagedWork(new Error('inactivity timeout'), {
      dir,
      logger: silentLogger,
      pushWorkOnce: async () => {},
      inFlightPush: () => Promise.reject(new Error('remote hung up')),
    })
    expect((rethrown as Error).message).toMatch(/salvaged into commit/)
  })

  it('says the commit is LOST when its push fails, rather than naming it as delivered', async () => {
    const rethrown = await withSalvagedWork(new Error('inactivity timeout'), {
      dir,
      logger: silentLogger,
      pushWorkOnce: async () => {
        throw new Error('non-fast-forward')
      },
      inFlightPush: () => null,
    })
    const message = (rethrown as Error).message
    expect(message).toMatch(/could NOT be pushed/)
    expect(message).toMatch(/non-fast-forward/)
    expect(message).toMatch(/lost with the container/)
  })

  it('reports the original failure untouched when there was nothing to salvage', async () => {
    await git('add', '-A')
    await git('commit', '-m', 'the agent committed its own work')
    const original = new Error('inactivity timeout')
    const rethrown = await withSalvagedWork(original, {
      dir,
      logger: silentLogger,
      pushWorkOnce: async () => {
        throw new Error('should never be pushed')
      },
      inFlightPush: () => null,
    })
    expect(rethrown).toBe(original)
    expect(original.message).toBe('inactivity timeout')
  })
})
