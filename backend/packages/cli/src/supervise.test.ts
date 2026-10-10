import { describe, expect, it } from 'vitest'
import {
  initialState,
  resolveSuperviseConfig,
  type SuperviseConfig,
  type SuperviseState,
  stateAfterStart,
  step,
} from './supervise.js'

const config: SuperviseConfig = resolveSuperviseConfig({
  pollMs: 10_000,
  bootGraceMs: 60_000,
  resumeGraceMs: 25_000,
  failureThreshold: 3,
})

/**
 * A state that is past every grace window, so failures count immediately — and that has ALREADY
 * seen the stack serve, which is what a supervisor watching a long-running child looks like. The
 * `servedSinceStart` half matters: it is what separates an outage something else caused from our
 * own child still binding, so a helper that quietly said `false` would classify every recovery
 * built on it as a slow start.
 */
function settled(now: number, failures = 0): SuperviseState {
  return { failures, quietUntil: now - 1, lastTickAt: now - config.pollMs, servedSinceStart: true }
}

/**
 * Walk `answers.length` ticks forward one `pollMs` at a time from `startedAt`, returning the last
 * tick's result. Real ticks, never one big jump: a jump larger than `clockJumpMs` is by design read
 * as a host suspend, so a test that fast-forwards past a grace window lands in the resume branch
 * and proves nothing about the window it meant to outlast.
 */
function walk(
  startedAt: number,
  state: SuperviseState,
  answers: boolean[],
): ReturnType<typeof step> {
  let current = state
  let result = step(current, { now: startedAt, serving: answers[0] ?? false }, config)
  answers.forEach((serving, index) => {
    if (index === 0) return
    current = result.state
    result = step(current, { now: startedAt + index * config.pollMs, serving }, config)
  })
  return result
}

/** A state for a child that has been started but has never yet answered a probe. */
function booting(now: number, graceMs = 30_000): SuperviseState {
  return {
    failures: 0,
    quietUntil: now + graceMs,
    lastTickAt: now - config.pollMs,
    servedSinceStart: false,
  }
}

describe('resolveSuperviseConfig', () => {
  it('derives the clock-jump threshold from the poll interval', () => {
    expect(resolveSuperviseConfig({ pollMs: 5_000 }).clockJumpMs).toBe(15_000)
  })

  it('applies defaults for anything unset', () => {
    const resolved = resolveSuperviseConfig()
    expect(resolved.pollMs).toBe(10_000)
    expect(resolved.failureThreshold).toBe(3)
    expect(resolved.bootGraceMs).toBe(60_000)
    expect(resolved.maxFailedStarts).toBe(5)
  })
})

describe('step — healthy', () => {
  it('reports plain serving and keeps failures at zero', () => {
    const now = 1_000_000
    const { state, action } = step(settled(now), { now, serving: true }, config)
    expect(action).toEqual({ kind: 'serving' })
    expect(state.failures).toBe(0)
  })

  it('reports recovery when it was previously failing, and clears the count', () => {
    const now = 1_000_000
    const { state, action } = step(settled(now, 2), { now, serving: true }, config)
    expect(action).toEqual({
      kind: 'recovered',
      afterFailures: 2,
      downMs: 0,
      cause: 'unexplained',
    })
    expect(state.failures).toBe(0)
  })
})

describe('step — outage duration', () => {
  it('stamps the start of an outage when the first failure is counted', () => {
    const now = 1_000_000
    const { state } = step(settled(now), { now, serving: false }, config)
    expect(state.notServingSince).toBe(now)
  })

  it('keeps the ORIGINAL stamp across further failures, so the window is not restarted', () => {
    const first = 1_000_000
    const one = step(settled(first), { now: first, serving: false }, config)
    const second = first + config.pollMs
    const two = step(one.state, { now: second, serving: false }, config)
    expect(two.state.notServingSince).toBe(first)
  })

  it('reports how long the stack was down, measured from the first failed probe', () => {
    const down = 1_000_000
    const failed = step(settled(down), { now: down, serving: false }, config)
    const back = down + 19_300
    const { state, action } = step(failed.state, { now: back, serving: true }, config)
    expect(action).toEqual({
      kind: 'recovered',
      afterFailures: 1,
      downMs: 19_300,
      cause: 'unexplained',
    })
    // Cleared on recovery, so the NEXT outage measures its own window rather than accumulating.
    expect(state.notServingSince).toBeUndefined()
  })

  it('does not count a cold boot as an outage — grace-window ticks leave the stamp unset', () => {
    const now = 1_000_000
    const { state, action } = step(booting(now), { now, serving: false }, config)
    expect(action.kind).toBe('grace')
    expect(state.notServingSince).toBeUndefined()
  })

  it('carries NO stamp into a repair, whose state a respawn replaces wholesale', () => {
    // The repair branches deliberately return no outage window: `runSupervisor` answers every
    // `repair` by restarting, and `stateAfterStart` overwrites this state the moment the new child
    // exists. A stamp here would be a value no reader can reach, and a test pinning one would
    // assert a contract nothing honours.
    const now = 1_000_000
    const { state, action } = step(settled(now, 2), { now, serving: false }, config)
    expect(action.kind).toBe('repair')
    expect(state.notServingSince).toBeUndefined()
  })
})

describe('step — who caused the gap', () => {
  it('blames nobody for a boot that outran the grace window', () => {
    // The misdiagnosis this exists to prevent: a cold boot slower than `bootGraceMs` counts real
    // failures and then recovers, which looked exactly like an outage a third party caused. The
    // stack had never answered, so there was nothing running for anything to restart.
    const started = 1_000_000
    // Grace out, one probe that misses because the port is not bound yet, then the port binds.
    // The grace window swallows the ticks strictly inside it; the one landing ON its edge is the
    // first that counts, so exactly one failure is on the clock when the port finally binds.
    const insideGrace = config.bootGraceMs / config.pollMs - 1
    const answers = [...Array<boolean>(insideGrace + 1).fill(false), true]
    const { action } = walk(started + config.pollMs, initialState(started, config), answers)
    expect(action).toMatchObject({ kind: 'recovered', afterFailures: 1, cause: 'slow-start' })
  })

  it("does not blame a third party for the supervisor's OWN restart binding late", () => {
    // Same shape one layer up: the repair itself re-bases the grace window, so a restarted stack
    // that takes longer than `bootGraceMs` to bind used to recover as `no repair of ours caused
    // it` — naming an invisible third party for a gap the supervisor had just created.
    const restartedAt = 2_000_000
    // The grace window swallows the ticks strictly inside it; the one landing ON its edge is the
    // first that counts, so exactly one failure is on the clock when the port finally binds.
    const insideGrace = config.bootGraceMs / config.pollMs - 1
    const answers = [...Array<boolean>(insideGrace + 1).fill(false), true]
    const { action } = walk(
      restartedAt + config.pollMs,
      stateAfterStart(restartedAt, config),
      answers,
    )
    expect(action).toMatchObject({ cause: 'slow-start' })
  })

  it('calls it unexplained once the stack has served, then gone, then come back', () => {
    // The genuine article: the stack answered, stopped answering, and came back with no repair in
    // between, so something cycled it underneath the supervisor.
    const started = 1_000_000
    // Answers immediately, keeps answering out past the grace window, then drops one probe.
    const graceTicks = config.bootGraceMs / config.pollMs
    const answers = [...Array<boolean>(graceTicks + 1).fill(true), false, true]
    const { action } = walk(started + config.pollMs, initialState(started, config), answers)
    expect(action).toMatchObject({ cause: 'unexplained' })
  })

  it('a resume that finds the stack alive counts as having served', () => {
    const lastTickAt = 1_000_000
    const now = lastTickAt + 600_000
    const state: SuperviseState = {
      failures: 0,
      quietUntil: 0,
      lastTickAt,
      servedSinceStart: false,
    }
    expect(step(state, { now, serving: true }, config).state.servedSinceStart).toBe(true)
  })
})

describe('step — boot grace', () => {
  it('does not count a failure while inside the grace window', () => {
    const now = 1_000_000
    const result = step(booting(now), { now, serving: false }, config)
    expect(result.action).toEqual({ kind: 'grace', msLeft: 30_000 })
    expect(result.state.failures).toBe(0)
  })

  it('a fresh child gets a full boot grace', () => {
    const now = 1_000_000
    expect(initialState(now, config).quietUntil).toBe(now + config.bootGraceMs)
  })

  it('a restart resets the counters and re-arms the grace window', () => {
    const now = 2_000_000
    const next = stateAfterStart(now, config)
    expect(next.failures).toBe(0)
    expect(next.quietUntil).toBe(now + config.bootGraceMs)
  })

  it('re-bases lastTickAt on the restart, so a SLOW repair is not read as a host sleep', () => {
    // The regression: a repair runs the dependency ladder first, whose budgets are 90s (compose)
    // and 120s (apiserver) against a 30s clock-jump threshold. Carrying the pre-repair tick forward
    // made the next tick measure the repair's own duration as drift, so a slow-but-SUCCESSFUL
    // recovery was misread as a suspend — and since resume detection outranks the boot grace, the
    // freshly started child was killed immediately.
    const repairTickAt = 1_000_000
    const restartedAt = repairTickAt + 60_000 // the ladder took a minute to bring Postgres back
    const state = stateAfterStart(restartedAt, config)

    const nextTickAt = restartedAt + config.pollMs
    const { action } = step(state, { now: nextTickAt, serving: false }, config)

    // Still booting, so it waits the grace out. It must NOT read as `repair`.
    expect(action.kind).toBe('grace')
  })
})

describe('step — the child process exited', () => {
  it('repairs at once, without counting probes against a process that no longer exists', () => {
    const now = 1_000_000
    const { action } = step(settled(now), { now, serving: false, childExited: true }, config)
    expect(action).toEqual({ kind: 'repair', reason: 'the supervised command exited' })
  })

  it('outranks the boot-grace window', () => {
    const now = 1_000_000
    expect(step(booting(now), { now, serving: false, childExited: true }, config).action.kind).toBe(
      'repair',
    )
  })

  it('leaves a SERVING stack alone even when the child handle is gone', () => {
    // A wrapper that execs away (or otherwise exits while its grandchild keeps the socket) must not
    // have a healthy server restarted out from under it — serving is checked first, deliberately.
    const now = 1_000_000
    const { action } = step(settled(now), { now, serving: true, childExited: true }, config)
    expect(action).toEqual({ kind: 'serving' })
  })
})

describe('step — failure accumulation', () => {
  it('counts below the threshold without repairing', () => {
    const now = 1_000_000
    const first = step(settled(now), { now, serving: false }, config)
    expect(first.action).toEqual({ kind: 'counting', failures: 1, threshold: 3 })

    const secondNow = now + config.pollMs
    const second = step(
      { ...first.state, lastTickAt: now },
      { now: secondNow, serving: false },
      config,
    )
    expect(second.action).toEqual({ kind: 'counting', failures: 2, threshold: 3 })
  })

  it('repairs on the threshold-th consecutive failure and resets the count', () => {
    const now = 1_000_000
    const { state: next, action } = step(settled(now, 2), { now, serving: false }, config)
    expect(action).toEqual({
      kind: 'repair',
      reason: '3 consecutive failed health probes',
    })
    expect(next.failures).toBe(0)
  })

  it('a single success resets a partial failure streak', () => {
    const now = 1_000_000
    const recovered = step(settled(now, 2), { now, serving: true }, config)
    const later = now + config.pollMs
    const afterwards = step(
      { ...recovered.state, lastTickAt: now },
      { now: later, serving: false },
      config,
    )
    // Back to 1, not 3 — so a flapping probe never accumulates its way to a needless restart.
    expect(afterwards.action).toEqual({ kind: 'counting', failures: 1, threshold: 3 })
  })
})

describe('step — sleep/resume detection', () => {
  it('treats a badly late tick as a resume and confirms a surviving stack', () => {
    const lastTickAt = 1_000_000
    const now = lastTickAt + 600_000 // ten minutes late: the host was suspended
    const state: SuperviseState = { failures: 0, quietUntil: 0, lastTickAt, servedSinceStart: true }
    const { state: next, action } = step(state, { now, serving: true }, config)
    expect(action.kind).toBe('resumed')
    // The resume grace is armed even on success: Docker/Postgres may still be waking.
    expect(next.quietUntil).toBe(now + config.resumeGraceMs)
  })

  it('repairs IMMEDIATELY after a resume, without waiting out the threshold', () => {
    const lastTickAt = 1_000_000
    const now = lastTickAt + 3_600_000 // an hour asleep
    const state: SuperviseState = { failures: 0, quietUntil: 0, lastTickAt, servedSinceStart: true }
    const { action } = step(state, { now, serving: false }, config)
    expect(action.kind).toBe('repair')
    expect(action).toMatchObject({ reason: expect.stringContaining('host slept?') })
  })

  it('outranks an active grace window — a resume is when the stack is most likely dead', () => {
    const lastTickAt = 1_000_000
    const now = lastTickAt + 600_000
    // Still inside a boot grace, which would normally suppress the failure entirely.
    const state: SuperviseState = {
      failures: 0,
      quietUntil: now + 30_000,
      lastTickAt,
      servedSinceStart: true,
    }
    const { action } = step(state, { now, serving: false }, config)
    expect(action.kind).toBe('repair')
  })

  it('ordinary scheduler jitter is NOT a resume', () => {
    const lastTickAt = 1_000_000
    // Late, but under the 3-interval threshold: a busy event loop, not a suspend.
    const now = lastTickAt + config.pollMs + config.clockJumpMs - 1
    const state: SuperviseState = { failures: 0, quietUntil: 0, lastTickAt, servedSinceStart: true }
    const { action } = step(state, { now, serving: true }, config)
    expect(action).toEqual({ kind: 'serving' })
  })
})
