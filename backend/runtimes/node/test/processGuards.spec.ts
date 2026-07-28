import { afterEach, describe, expect, it } from 'vitest'
import { createRecordingLogger } from '@cat-factory/kernel'
import {
  installProcessFailureGuards,
  resetProcessFailureGuardsForTest,
} from '../src/processGuards.js'

// The guards' whole value is the DISPOSITION difference: a stray rejection must not kill a
// healthy orchestrator, while an uncaught exception must not leave one running on unknown
// invariants. Both are asserted here rather than left to a boot-time smoke test, since neither
// is reachable from the HTTP surface.

afterEach(() => resetProcessFailureGuardsForTest())

describe('installProcessFailureGuards', () => {
  it('logs an unhandled rejection and leaves the process running', () => {
    const logger = createRecordingLogger()
    const exits: number[] = []
    installProcessFailureGuards(logger, (code) => exits.push(code))

    process.emit('unhandledRejection', new Error('a dropped background promise'), Promise.resolve())

    expect(logger.lines).toHaveLength(1)
    expect(logger.lines[0]).toMatchObject({
      level: 'error',
      msg: 'unhandled promise rejection',
      fields: { guard: 'unhandledRejection', err: 'a dropped background promise' },
    })
    expect(exits).toEqual([])
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
})
