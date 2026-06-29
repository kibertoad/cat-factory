import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { killChildProcess } from '../src/process.js'
import { log } from '../src/logger.js'

// A minimal fake child: records the signals it received and lets the test choose whether
// it "exited" (exitCode/signalCode non-null) after the SIGTERM grace window.
function fakeChild(opts: { exitsAfterTerm: boolean }): ChildProcess & { signals: string[] } {
  const signals: string[] = []
  const child = {
    signals,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(String(signal))
      // Simulate a well-behaved process exiting on SIGTERM before the grace timer fires.
      if (signal === 'SIGTERM' && opts.exitsAfterTerm) this.exitCode = 0
      return true
    },
  }
  return child as unknown as ChildProcess & { signals: string[] }
}

afterEach(() => vi.restoreAllMocks())

describe('killChildProcess', () => {
  it('escalates to SIGKILL and warns when the process ignores SIGTERM', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const child = fakeChild({ exitsAfterTerm: false })

    killChildProcess(child, 5_000)
    expect(child.signals).toEqual(['SIGTERM'])

    vi.advanceTimersByTime(5_000)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/escalating to SIGKILL/),
      expect.objectContaining({ graceMs: 5_000 }),
    )
    vi.useRealTimers()
  })

  it('does not escalate or warn when the process exits on SIGTERM', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const child = fakeChild({ exitsAfterTerm: true })

    killChildProcess(child, 5_000)
    vi.advanceTimersByTime(5_000)

    expect(child.signals).toEqual(['SIGTERM'])
    expect(warn).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
