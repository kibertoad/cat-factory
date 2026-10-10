import { afterEach, describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import {
  installProcessFailureGuards,
  resetProcessFailureGuardsForTest,
} from '../src/processGuards.js'

// The guards exist to add EVIDENCE without moving the line on when the process stays up: Node
// already terminates on both conditions (since 15, an unhandled rejection is raised as an uncaught
// exception), and registering a listener is what would silently take that decision away. So both
// specs assert the log AND the non-zero exit. Neither path is reachable from the HTTP surface, so
// this is the only place the disposition is pinned.

afterEach(() => resetProcessFailureGuardsForTest())

describe('installProcessFailureGuards', () => {
  it('logs an unhandled rejection and still exits non-zero, as Node would have', () => {
    const logger = createRecordingLogger()
    const exits: number[] = []
    installProcessFailureGuards(logger, (code) => exits.push(code))

    process.emit('unhandledRejection', new Error('a dropped background promise'), Promise.resolve())

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toMatchObject({
      level: 'error',
      msg: 'unhandled promise rejection; exiting',
      fields: { guard: 'unhandledRejection', err: 'a dropped background promise' },
    })
    expect(exits).toEqual([1])
  })

  it('logs an uncaught exception and exits non-zero', () => {
    const logger = createRecordingLogger()
    const exits: number[] = []
    installProcessFailureGuards(logger, (code) => exits.push(code))

    process.emit('uncaughtException', new Error('unwound an unknown stack'))

    expect(logger.lines[0]).toMatchObject({
      level: 'error',
      msg: 'uncaught exception; exiting',
      fields: { guard: 'uncaughtException' },
    })
    expect(exits).toEqual([1])
  })

  it('is idempotent, so the local facade booting on top of `start` does not double-log', () => {
    const logger = createRecordingLogger()
    installProcessFailureGuards(logger, () => {})
    installProcessFailureGuards(logger, () => {})

    process.emit('unhandledRejection', new Error('once'), Promise.resolve())

    expect(logger.lines).toHaveLength(1)
  })

  it("removes only its own listeners on reset, leaving the test runner's in place", () => {
    // `removeAllListeners` here would strip vitest's own handlers and misreport whatever fails
    // next in this worker, so the reset is pinned to the listeners we actually added.
    const foreign = (): void => {}
    process.on('uncaughtException', foreign)
    try {
      installProcessFailureGuards(createRecordingLogger(), () => {})
      resetProcessFailureGuardsForTest()
      expect(process.listeners('uncaughtException')).toContain(foreign)
    } finally {
      process.off('uncaughtException', foreign)
    }
  })
})
