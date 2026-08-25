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

/** A state that is past every grace window, so failures count immediately. */
function settled(now: number, failures = 0): SuperviseState {
  return { failures, quietUntil: now - 1, lastTickAt: now - config.pollMs }
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
    expect(action).toEqual({ kind: 'recovered', afterFailures: 2, downMs: 0 })
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
    expect(action).toEqual({ kind: 'recovered', afterFailures: 1, downMs: 19_300 })
    // Cleared on recovery, so the NEXT outage measures its own window rather than accumulating.
    expect(state.notServingSince).toBeUndefined()
  })

  it('does not count a cold boot as an outage — grace-window ticks leave the stamp unset', () => {
    const now = 1_000_000
    const booting: SuperviseState = {
      failures: 0,
      quietUntil: now + 30_000,
      lastTickAt: now - config.pollMs,
    }
    const { state, action } = step(booting, { now, serving: false }, config)
    expect(action.kind).toBe('grace')
    expect(state.notServingSince).toBeUndefined()
  })

  it('stamps the outage when a repair is triggered, so the ladder can report it too', () => {
    const now = 1_000_000
    const { state } = step(settled(now, 2), { now, serving: false }, config)
    expect(state.notServingSince).toBe(now)
  })
})

describe('step — boot grace', () => {
  it('does not count a failure while inside the grace window', () => {
    const now = 1_000_000
    const state: SuperviseState = {
      failures: 0,
      quietUntil: now + 30_000,
      lastTickAt: now - config.pollMs,
    }
    const result = step(state, { now, serving: false }, config)
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
    const state: SuperviseState = {
      failures: 0,
      quietUntil: now + 30_000,
      lastTickAt: now - config.pollMs,
    }
    expect(step(state, { now, serving: false, childExited: true }, config).action.kind).toBe(
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
    const state: SuperviseState = {
      failures: 2,
      quietUntil: now - 1,
      lastTickAt: now - config.pollMs,
    }
    const { state: next, action } = step(state, { now, serving: false }, config)
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
    const state: SuperviseState = { failures: 0, quietUntil: 0, lastTickAt }
    const { state: next, action } = step(state, { now, serving: true }, config)
    expect(action.kind).toBe('resumed')
    // The resume grace is armed even on success: Docker/Postgres may still be waking.
    expect(next.quietUntil).toBe(now + config.resumeGraceMs)
  })

  it('repairs IMMEDIATELY after a resume, without waiting out the threshold', () => {
    const lastTickAt = 1_000_000
    const now = lastTickAt + 3_600_000 // an hour asleep
    const state: SuperviseState = { failures: 0, quietUntil: 0, lastTickAt }
    const { action } = step(state, { now, serving: false }, config)
    expect(action.kind).toBe('repair')
    expect(action).toMatchObject({ reason: expect.stringContaining('host slept?') })
  })

  it('outranks an active grace window — a resume is when the stack is most likely dead', () => {
    const lastTickAt = 1_000_000
    const now = lastTickAt + 600_000
    // Still inside a boot grace, which would normally suppress the failure entirely.
    const state: SuperviseState = { failures: 0, quietUntil: now + 30_000, lastTickAt }
    const { action } = step(state, { now, serving: false }, config)
    expect(action.kind).toBe('repair')
  })

  it('ordinary scheduler jitter is NOT a resume', () => {
    const lastTickAt = 1_000_000
    // Late, but under the 3-interval threshold: a busy event loop, not a suspend.
    const now = lastTickAt + config.pollMs + config.clockJumpMs - 1
    const state: SuperviseState = { failures: 0, quietUntil: 0, lastTickAt }
    const { action } = step(state, { now, serving: true }, config)
    expect(action).toEqual({ kind: 'serving' })
  })
})
